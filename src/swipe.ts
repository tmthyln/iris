import {ref, type CSSProperties} from "vue"

interface SwipeItem {
    guid: string
}

export function useSwipeToDismiss<T extends SwipeItem>(
    onDismiss: (item: T) => void,
    {threshold = 100, ignoreSelector}: {threshold?: number, ignoreSelector?: string} = {},
) {
    const swipeState = ref<{guid: string, startX: number, dx: number} | null>(null)

    function onTouchStart(item: T, e: TouchEvent) {
        if (ignoreSelector && e.target instanceof Element && e.target.closest(ignoreSelector)) return
        swipeState.value = {guid: item.guid, startX: e.touches[0].clientX, dx: 0}
    }

    function onTouchMove(e: TouchEvent) {
        if (!swipeState.value) return
        swipeState.value.dx = e.touches[0].clientX - swipeState.value.startX
    }

    function onTouchEnd(item: T) {
        if (!swipeState.value) return
        if (Math.abs(swipeState.value.dx) > threshold) {
            onDismiss(item)
        }
        swipeState.value = null
    }

    function swipeStyle(item: T): CSSProperties {
        if (swipeState.value?.guid === item.guid) {
            return {
                transform: `translateX(${swipeState.value.dx}px)`,
                opacity: 1 - Math.abs(swipeState.value.dx) / (threshold * 2),
            }
        }
        return {}
    }

    return {onTouchStart, onTouchMove, onTouchEnd, swipeStyle}
}
