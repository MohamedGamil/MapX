import Vue from 'vue';
import VueRouter from 'vue-router';
import HomeView from '../views/HomeView.vue';
import TicketList from '../views/TicketList.vue';
import NotificationsView from '../views/NotificationsView.vue';

Vue.use(VueRouter);

export default new VueRouter({
  mode: 'history',
  routes: [
    // The route is named after the dashboard, but renders HomeView (components/Dashboard.vue is a widget).
    { path: '/', name: 'Dashboard', component: HomeView },
    { path: '/tickets', name: 'tickets', component: TicketList },
    { path: '/tickets/:id', name: 'ticket-detail', component: () => import('../views/TicketDetail.vue'), props: true },
    { path: '/notifications', name: 'notifications', component: NotificationsView },
  ],
});
