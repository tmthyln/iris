import HomePage from "../components/HomePage.vue";

export default [
    {
        name: 'home',
        path: '/',
        component: HomePage,
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
