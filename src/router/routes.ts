import Home from "../components/Home.vue";

export default [
    {
        name: 'home',
        path: '/',
        component: Home,
    }, {
        name: 'podcast',
        path: '/podcasts/:guid',
        component: () => import('../components/SubscriptionView.vue'),
        props: true,
    }, {
        name: 'episode',
        path: '/podcasts/episode/:guid',
        component: () => import('../components/ItemView.vue'),
        props: true,
    }, {
        name: 'blog',
        path: '/blogs/:guid',
        component: () => import('../components/SubscriptionView.vue'),
        props: true,
    }, {
        name: 'post',
        path: '/blogs/post/:guid',
        component: () => import('../components/ItemView.vue'),
        props: true,
    },
]
