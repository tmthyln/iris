import {describe, expect, it} from 'vitest'
import router from './index.ts'

describe('router reauth param handling', () => {
    it('strips the reauth param appended by client.ts, keeping the rest of the query', async () => {
        await router.push('/?reauth=1755900000000&page=2')
        expect(router.currentRoute.value.query).toEqual({page: '2'})
    })

    it('keeps path and hash while stripping the param', async () => {
        await router.push('/downloads?reauth=1#anchor')
        expect(router.currentRoute.value.path).toBe('/downloads')
        expect(router.currentRoute.value.hash).toBe('#anchor')
        expect(router.currentRoute.value.query).toEqual({})
    })

    it('leaves navigations without the param alone', async () => {
        await router.push('/?page=3')
        expect(router.currentRoute.value.query).toEqual({page: '3'})
    })
})
