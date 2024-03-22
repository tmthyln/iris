import {MaybeRefOrGetter, ref, toValue, watchEffect} from "vue";

export function useUnescapedHTML(raw: MaybeRefOrGetter<string>) {
    const parser = new DOMParser()
    const output = ref<string>('')

    watchEffect(() => {
        const doc = parser.parseFromString(toValue(raw), 'text/html')
        output.value = doc.documentElement.textContent
    })

    return output
}
