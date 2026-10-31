import { createRouter, createWebHistory } from 'vue-router';
import ProductList from '../views/ProductList.vue';
import CartView from '../views/CartView.vue';
import OrderConfirmation from '../views/OrderConfirmation.vue';
import OrderList from '../views/OrderList.vue';

export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'products', component: ProductList },
    { path: '/products/:id', name: 'product-detail', component: () => import('../views/ProductDetail.vue') },
    { path: '/cart', name: 'cart', component: CartView },
    { path: '/order/confirmed', name: 'order-confirmation', component: OrderConfirmation },
    { path: '/orders', name: 'orders', component: OrderList },
  ],
});
