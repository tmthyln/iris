import type {App} from 'vue'
import type {Router} from 'vue-router'
import client, {onApiFailure, type ApiFailure} from './client'
import type {ClientLogEvent} from './types'

/*
 * Frontend error reporting. Reports are mirrored to the console and sent in
 * batches to POST /api/client-log, where the Worker logs them with this page
 * load's session id (and, for a failed API call, that call's request id), next
 * to the backend's own log lines for the same ids — see
 * src/services/utils/log.ts. In `npm run dev` they land in the Vite terminal.
 */

type Level = ClientLogEvent['level']
export type ReportDetails = Record<string, string | number | boolean | null | undefined>

export interface ReportOptions {
    /** The X-Request-Id of the API call this is about. */
    requestId?: string
    /** The thrown value; its name, message and stack are included. */
    error?: unknown
    details?: ReportDetails
}

const FLUSH_DELAY_MS = 2000
/** The Worker accepts at most this many events per request. */
const MAX_BATCH = 25
/** Identical reports beyond this many per page load are dropped. */
const MAX_REPEATS = 3
/** A runaway error loop stops being reported after this many events. */
const MAX_EVENTS_PER_PAGE = 200

const CLIENT_LOG_PATH = '/api/client-log'

const pending: ClientLogEvent[] = []
const repeats = new Map<string, number>()
let reported = 0
let flushTimer: ReturnType<typeof setTimeout> | null = null

function describe(value: unknown): string {
    if (value instanceof Error) return `${value.name}: ${value.message}`
    if (typeof value === 'string') return value
    try {
        return JSON.stringify(value) ?? String(value)
    } catch {
        return String(value)
    }
}

export function report(level: Level, message: string, {requestId, error, details = {}}: ReportOptions = {}) {
    const consoleArgs: unknown[] = [message]
    if (error !== undefined) consoleArgs.push(error)
    if (Object.keys(details).length > 0) consoleArgs.push(details)
    console[level](...consoleArgs)

    const cleaned: Record<string, string | number | boolean | null> = {}
    for (const [key, value] of Object.entries(details)) {
        if (value !== undefined) cleaned[key] = value
    }
    if (error !== undefined) cleaned.error = describe(error)

    const key = `${level}|${message}|${JSON.stringify(cleaned)}`
    const count = (repeats.get(key) ?? 0) + 1
    repeats.set(key, count)
    if (count > MAX_REPEATS || reported >= MAX_EVENTS_PER_PAGE) return
    reported++

    pending.push({
        level,
        message,
        requestId,
        stack: error instanceof Error ? error.stack : undefined,
        url: window.location.href,
        at: new Date().toISOString(),
        details: cleaned,
    })
    flushTimer ??= setTimeout(flush, FLUSH_DELAY_MS)
}

/** Sends everything buffered; also called when the page is hidden. */
export function flush() {
    if (flushTimer !== null) clearTimeout(flushTimer)
    flushTimer = null
    while (pending.length > 0) {
        void client.reportClientEvents(pending.splice(0, MAX_BATCH))
    }
}

function reportApiFailure({requestId, method, path, status, error}: ApiFailure) {
    // Never report on the reporting endpoint itself (it would loop), and don't
    // report requests that failed only because the device is offline.
    if (path === CLIENT_LOG_PATH) return
    if (status === null && !navigator.onLine) return
    const level = status === null || status >= 500 ? 'error' : 'warn'
    report(level, `API ${method} ${path} failed`, {requestId, details: {method, path, status, error}})
}

/** Installs the global handlers; call once at startup. */
export function installErrorReporting(app: App, router: Router) {
    app.config.errorHandler = (err, _instance, info) => {
        report('error', `Vue error: ${describe(err)}`, {error: err, details: {vueInfo: info}})
    }
    router.onError((err, to) => {
        report('error', `Navigation error: ${describe(err)}`, {error: err, details: {route: to.fullPath}})
    })
    window.addEventListener('error', (event) => {
        report('error', `Uncaught error: ${event.message}`, {
            error: event.error,
            details: {source: event.filename, line: event.lineno, column: event.colno},
        })
    })
    window.addEventListener('unhandledrejection', (event) => {
        report('error', `Unhandled promise rejection: ${describe(event.reason)}`, {error: event.reason})
    })
    onApiFailure(reportApiFailure)
    // Pending reports would be lost with the page; keepalive lets them finish.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush()
    })
    window.addEventListener('pagehide', flush)
}
