import Home from "../components/Home.vue";

export default [
    {
        name: 'home',
        path: '/',
        component: Home,
    }, {
        name: 'subscription',
        path: '/subscriptions/:guid',
        component: () => import('../components/SubscriptionView.vue'),
        props: true,
    }, {
        name: 'item',
        path: '/subscriptions/item/:guid',
        component: () => import('../components/ItemView.vue'),
        props: true,
    },
]
