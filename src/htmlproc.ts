import DOMPurify from "dompurify";
import {type MaybeRefOrGetter, ref, toValue, watchEffect} from "vue";

// Cross-origin embeds (video players, mostly) need scripts and their own origin to work. In a
// sandbox they can't navigate the app, and across origins they can't reach it.
const EMBED_SANDBOX = 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation'

const SANITIZE_CONFIG = {
    ADD_TAGS: ['iframe'],
    ADD_ATTR: ['allowfullscreen', 'frameborder'],
    // <style> would restyle the whole app; a form could pose as the app and post anywhere.
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'select', 'textarea'],
    FORBID_ATTR: ['autoplay'],
}

DOMPurify.addHook('afterSanitizeAttributes', node => {
    if (node.tagName !== 'IFRAME') return

    const src = parseUrl(node.getAttribute('src') ?? '', location.href)
    if (src?.protocol !== 'https:' || src.origin === location.origin) {
        node.remove()
        return
    }
    node.setAttribute('src', src.href)
    node.setAttribute('sandbox', EMBED_SANDBOX)
    node.setAttribute('loading', 'lazy')
})

// Everything a feed supplies as HTML goes through this on its way to v-html: any feed can publish
// markup, and a script running here would have the whole API of the logged-in session.
export function sanitizeHTML(raw: string | null | undefined) {
    return raw ? DOMPurify.sanitize(raw, SANITIZE_CONFIG) : ''
}

// For a URL a feed supplies, bound to an href: Vue doesn't filter out javascript: URLs.
export function safeLinkUrl(url: string | null | undefined) {
    const protocol = url ? parseUrl(url)?.protocol : undefined
    return protocol === 'http:' || protocol === 'https:' ? url! : undefined
}

function parseUrl(url: string, base?: string) {
    try {
        return new URL(url, base)
    } catch {
        return null
    }
}

export function useUnescapedHTML(raw: MaybeRefOrGetter<string>) {
    const output = ref<string>('')

    watchEffect(() => {
        output.value = unescapeHTML(toValue(raw))
    })

    return output
}

export function unescapeHTML(raw: string) {
    return new DOMParser().parseFromString(raw, 'text/html').documentElement.textContent
}

export function prefetchImagesFromHtml(...htmlSources: (string | null | undefined)[]) {
    if (typeof window === 'undefined') return
    const parser = new DOMParser()
    const seen = new Set<string>()
    for (const html of htmlSources) {
        if (!html) continue
        const doc = parser.parseFromString(html, 'text/html')
        for (const img of doc.querySelectorAll('img[src]')) {
            const src = img.getAttribute('src')
            if (!src || seen.has(src)) continue
            seen.add(src)
            // Setting .src on a detached Image triggers a fetch into the browser's HTTP cache
            // without the element ever being inserted into the document.
            new Image().src = src
        }
    }
}
