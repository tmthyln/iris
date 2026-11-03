import {ref, type CSSProperties} from "vue"

interface SwipeItem {
    guid: string
}

const VERTICAL_SLOP = 10

export function useSwipeToDismiss<T extends SwipeItem>(
    onDismiss: (item: T) => void,
    {threshold = 100, ignoreSelector}: {threshold?: number, ignoreSelector?: string} = {},
) {
    const swipeState = ref<{guid: string, startX: number, startY: number, dx: number} | null>(null)

    function onTouchStart(item: T, e: TouchEvent) {
        if (ignoreSelector && e.target instanceof Element && e.target.closest(ignoreSelector)) return
        swipeState.value = {guid: item.guid, startX: e.touches[0].clientX, startY: e.touches[0].clientY, dx: 0}
    }

    function onTouchMove(e: TouchEvent) {
        if (!swipeState.value) return
        const dx = e.touches[0].clientX - swipeState.value.startX
        const dy = e.touches[0].clientY - swipeState.value.startY
        // Mostly vertical is someone scrolling the list, not swiping an item away.
        if (Math.abs(dy) > VERTICAL_SLOP && Math.abs(dy) > Math.abs(dx)) {
            swipeState.value = null
            return
        }
        swipeState.value.dx = dx
    }

    function onTouchEnd(item: T) {
        if (!swipeState.value) return
        if (Math.abs(swipeState.value.dx) > threshold) {
            onDismiss(item)
        }
        swipeState.value = null
    }

    function onTouchCancel() {
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

    return {onTouchStart, onTouchMove, onTouchEnd, onTouchCancel, swipeStyle}
}
