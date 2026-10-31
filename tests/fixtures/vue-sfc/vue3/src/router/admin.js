// A route module (M3-11-R1): its records are spread into the router's routes (`...adminRoutes`).
export default [
  { path: '/admin/orders', name: 'admin-orders', component: () => import('../views/AdminOrders.vue') },
];
