import { defineStore } from 'pinia';
import router from '../router';

export const useSessionStore = defineStore('session', {
  state: () => ({ user: null, lastActivity: null }),
  actions: {
    touch() {
      this.lastActivity = Date.now();
    },
    async logout() {
      await fetch('/api/logout', { method: 'POST' });
      this.user = null;
      // The route named 'Dashboard' renders HomeView, not components/Dashboard.vue (M3-11).
      router.push({ name: 'Dashboard' });
    },
  },
});
