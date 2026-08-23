import {createRouter, createWebHistory} from "vue-router";
import routes from './routes';
import {REAUTH_PARAM} from '../client';

const router = createRouter({
    history: createWebHistory(import.meta.env.BASE_URL),
    routes,
});

// Drop the query param client.ts appends when re-authenticating with
// Cloudflare Access, so it doesn't linger in the address bar or bookmarks.
router.beforeEach((to) => {
    if (!(REAUTH_PARAM in to.query)) return
    const query = {...to.query}
    delete query[REAUTH_PARAM]
    return {path: to.path, query, hash: to.hash, replace: true}
})

export default router
