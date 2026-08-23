import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import {createPinia} from "pinia";

import './assets/styles.scss'

import {registerSW} from 'virtual:pwa-register'

registerSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
        if (!registration) return
        // Long-lived sessions (especially the installed PWA) rarely navigate,
        // which is when update checks normally happen — so also check when the
        // app is resumed, and hourly while it stays open.
        const update = () => void registration.update().catch(() => undefined)
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') update()
        })
        setInterval(update, 60 * 60 * 1000)
    },
})

createApp(App)
    .use(createPinia())
    .use(router)
    .mount('#app')
