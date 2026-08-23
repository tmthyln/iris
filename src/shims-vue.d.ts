// vue-tsc resolves `.vue` imports against the real SFCs, so this wildcard module is never
// consulted there; it exists for tools that type-check with plain TypeScript (typescript-eslint).
declare module '*.vue' {
    import type {DefineComponent} from 'vue'
    const component: DefineComponent
    export default component
}
