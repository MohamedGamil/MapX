import { defineStore } from 'pinia';

// Agent presence: also has a touch() action, unrelated to the session store's.
export const usePresenceStore = defineStore('presence', {
  state: () => ({ online: false, lastSeen: null }),
  actions: {
    touch() {
      this.online = true;
      this.lastSeen = Date.now();
    },
    // `this.router`: the router a Pinia plugin adds to every store (M3-11-R1).
    goOffline() {
      this.online = false;
      this.router.push({ name: 'notifications' });
    },
  },
});
