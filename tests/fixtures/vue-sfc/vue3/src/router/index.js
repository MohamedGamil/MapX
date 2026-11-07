import { createRouter, createWebHistory } from 'vue-router';
import ProductList from '../views/ProductList.vue';
// Imported under another name than the file's: the route resolves through the import (M3-06).
import ShoppingCart from '../views/CartView.vue';
import OrderConfirmation from '../views/OrderConfirmation.vue';
import OrderList from '../views/OrderList.vue';
// A route module exported as `export default [ … ]`, spread into the routes (M3-11-R1).
import adminRoutes from './admin';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'products', component: ProductList },
    { path: '/products/:id', name: 'product-detail', component: () => import('../views/ProductDetail.vue') },
    { path: '/cart', name: 'cart', component: ShoppingCart },
    { path: '/order/confirmed', name: 'order-confirmation', component: OrderConfirmation },
    { path: '/orders', name: 'orders', component: OrderList },
    ...adminRoutes,
  ],
});

// A guard redirects by returning a route location (Vue Router 4, M3-11-R1).
function guardCheckout(to) {
  if (to.name === 'order-confirmation' && !to.query.order) return { name: 'cart' };
  return true;
}

// Not a guard: the location it returns is a breadcrumb, not a redirect.
export function crumbFor() {
  return { name: 'orders', label: 'Orders' };
}

router.beforeEach(guardCheckout);

export default router;
