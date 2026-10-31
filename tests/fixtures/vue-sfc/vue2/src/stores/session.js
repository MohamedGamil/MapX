import { defineStore } from 'pinia';

export const useSessionStore = defineStore('session', {
  state: () => ({ user: null, lastActivity: null }),
  actions: {
    touch() {
      this.lastActivity = Date.now();
    },
    async logout() {
      await fetch('/api/logout', { method: 'POST' });
      this.user = null;
    },
  },
});
