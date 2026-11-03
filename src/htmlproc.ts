import {type MaybeRefOrGetter, ref, toValue, watchEffect} from "vue";

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
