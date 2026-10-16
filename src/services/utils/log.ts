import {AsyncLocalStorage} from 'node:async_hooks'

/**
 * Structured logging for the Worker.
 *
 * Every line is one JSON object, which Workers Logs indexes field by field, so
 * `requestId = …` or `sessionId = …` finds everything one API call or one
 * browser tab caused. The fields of the current log context (set per API
 * request, queue message and cron run) are merged into every line, so code
 * deep in a flow doesn't have to pass ids around.
 *
 * - requestId: the frontend's X-Request-Id for one API call (generated here
 *   when absent). Queue tasks carry it along (`trace`), so background work keeps
 *   the id of the request that started it.
 * - sessionId: the frontend's X-Client-Session, one per page load.
 *
 * Frontend error reports (POST /api/client-log) are logged with the same
 * fields and `source: 'client'`.
 */

export type LogFields = Record<string, unknown>

/** Ids carried by queue tasks so background work stays linked to its origin. */
export interface TaskTrace {
    readonly requestId?: string
    readonly sessionId?: string
}

const storage = new AsyncLocalStorage<LogFields>()

/** Runs `fn` with `fields` added to the current log context. */
export function withLogContext<T>(fields: LogFields, fn: () => T): T {
    return storage.run({...storage.getStore(), ...withoutUndefined(fields)}, fn)
}

export function logContext(): LogFields {
    return storage.getStore() ?? {}
}

/** The trace to attach to tasks enqueued from the current context, if any. */
export function currentTrace(): TaskTrace | undefined {
    const {requestId, sessionId} = logContext()
    if (typeof requestId !== 'string') return undefined
    return typeof sessionId === 'string' ? {requestId, sessionId} : {requestId}
}

/** Attaches the current trace to a task about to be enqueued. */
export function traced<T extends object>(task: T): T & {trace?: TaskTrace} {
    const trace = currentTrace()
    return trace ? {...task, trace} : task
}

/** Request/session ids come from the client; only accept short opaque tokens. */
export function sanitizeId(value: string | null | undefined): string | undefined {
    return value && /^[\w-]{1,64}$/.test(value) ? value : undefined
}

export function serializeError(err: unknown): LogFields {
    if (err instanceof Error) {
        // The cf project's lib predates Error.cause.
        const {cause} = err as {cause?: unknown}
        return {
            name: err.name,
            message: err.message,
            stack: err.stack,
            ...(cause !== undefined ? {cause: serializeError(cause)} : {}),
        }
    }
    return {message: String(err)}
}

function withoutUndefined(fields: LogFields): LogFields {
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
}

function emit(level: 'log' | 'warn' | 'error', message: string, fields: LogFields = {}) {
    const {error, ...rest} = fields
    console[level]({
        message,
        ...logContext(),
        ...withoutUndefined(rest),
        ...(error !== undefined ? {error: serializeError(error)} : {}),
    })
}

/** `fields.error` (any thrown value) is serialised with its name, message, stack and cause. */
export const log = {
    info: (message: string, fields?: LogFields) => emit('log', message, fields),
    warn: (message: string, fields?: LogFields) => emit('warn', message, fields),
    error: (message: string, fields?: LogFields) => emit('error', message, fields),
}
