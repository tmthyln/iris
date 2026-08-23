// Vite's `?raw` import, used to load fixture files (there is no filesystem inside workerd).
declare module '*?raw' {
    const content: string
    export default content
}
