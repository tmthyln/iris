import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import {createPinia} from "pinia";

import './assets/styles.scss'

import {registerSW} from 'virtual:pwa-register'

registerSW({immediate: true})

createApp(App)
    .use(createPinia())
    .use(router)
    .mount('#app')
