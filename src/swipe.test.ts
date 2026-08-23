import {describe, expect, it, vi} from 'vitest'
import {useSwipeToDismiss} from './swipe.ts'

function touch(clientX: number, target?: EventTarget): TouchEvent {
    return {touches: [{clientX}], target} as unknown as TouchEvent
}

const item = {guid: 'item-a'}

describe('useSwipeToDismiss', () => {
    it('dismisses an item swiped right past the threshold', () => {
        const onDismiss = vi.fn()
        const {onTouchStart, onTouchMove, onTouchEnd} = useSwipeToDismiss(onDismiss)
        onTouchStart(item, touch(200))
        onTouchMove(touch(320))
        onTouchEnd(item)
        expect(onDismiss).toHaveBeenCalledExactlyOnceWith(item)
    })

    it('dismisses an item swiped left past the threshold', () => {
        const onDismiss = vi.fn()
        const {onTouchStart, onTouchMove, onTouchEnd} = useSwipeToDismiss(onDismiss)
        onTouchStart(item, touch(200))
        onTouchMove(touch(50))
        onTouchEnd(item)
        expect(onDismiss).toHaveBeenCalledExactlyOnceWith(item)
    })

    it('keeps an item released within the threshold', () => {
        const onDismiss = vi.fn()
        const {onTouchStart, onTouchMove, onTouchEnd, swipeStyle} = useSwipeToDismiss(onDismiss)
        onTouchStart(item, touch(200))
        onTouchMove(touch(290))
        onTouchEnd(item)
        expect(onDismiss).not.toHaveBeenCalled()
        expect(swipeStyle(item)).toEqual({})   // state cleared
    })

    it('honours a custom threshold', () => {
        const onDismiss = vi.fn()
        const {onTouchStart, onTouchMove, onTouchEnd} = useSwipeToDismiss(onDismiss, {threshold: 30})
        onTouchStart(item, touch(0))
        onTouchMove(touch(40))
        onTouchEnd(item)
        expect(onDismiss).toHaveBeenCalledExactlyOnceWith(item)
    })

    it('translates and fades only the item being swiped', () => {
        const {onTouchStart, onTouchMove, swipeStyle} = useSwipeToDismiss(vi.fn())
        onTouchStart(item, touch(100))
        onTouchMove(touch(150))
        expect(swipeStyle(item)).toEqual({transform: 'translateX(50px)', opacity: 0.75})
        expect(swipeStyle({guid: 'other'})).toEqual({})
    })

    it('ignores touches starting on elements matching ignoreSelector', () => {
        const onDismiss = vi.fn()
        const handle = document.createElement('span')
        handle.className = 'drag-handle'
        const {onTouchStart, onTouchMove, onTouchEnd} = useSwipeToDismiss(onDismiss, {ignoreSelector: '.drag-handle'})
        onTouchStart(item, touch(0, handle))
        onTouchMove(touch(500))
        onTouchEnd(item)
        expect(onDismiss).not.toHaveBeenCalled()
    })

    it('ignores moves and releases without a tracked touch', () => {
        const onDismiss = vi.fn()
        const {onTouchMove, onTouchEnd} = useSwipeToDismiss(onDismiss)
        onTouchMove(touch(500))
        onTouchEnd(item)
        expect(onDismiss).not.toHaveBeenCalled()
    })
})
