import {ref, computed} from 'vue'

/**
 * Wraps an async function so that only the result of the most recent call is
 * returned. Results from superseded in-flight calls resolve to null.
 * Also tracks whether any calls are still pending.
 */
export function useLatestAsync<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => Promise<TResult>
) {
    const pending = ref(0)
    const isLoading = computed(() => pending.value > 0)

    let sequence = 0

    async function execute(...args: TArgs): Promise<TResult | null> {
        const seq = ++sequence
        pending.value++
        try {
            const result = await fn(...args)
            return seq === sequence ? result : null
        } finally {
            pending.value--
        }
    }

    return {execute, isLoading}
}
