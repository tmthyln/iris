import {ref, type CSSProperties} from "vue"

interface SwipeItem {
    guid: string
}

export function useSwipeToDismiss(onDismiss: (item: SwipeItem) => void, threshold = 100) {
    const swipeState = ref<{guid: string, startX: number, dx: number} | null>(null)

    function onTouchStart(item: SwipeItem, e: TouchEvent) {
        swipeState.value = {guid: item.guid, startX: e.touches[0].clientX, dx: 0}
    }

    function onTouchMove(e: TouchEvent) {
        if (!swipeState.value) return
        swipeState.value.dx = e.touches[0].clientX - swipeState.value.startX
    }

    function onTouchEnd(item: SwipeItem) {
        if (!swipeState.value) return
        if (Math.abs(swipeState.value.dx) > threshold) {
            onDismiss(item)
        }
        swipeState.value = null
    }

    function swipeStyle(item: SwipeItem): CSSProperties {
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
