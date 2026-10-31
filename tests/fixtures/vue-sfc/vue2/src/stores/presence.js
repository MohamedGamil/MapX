import { defineStore } from 'pinia';

// Agent presence: also has a touch() action, unrelated to the session store's.
export const usePresenceStore = defineStore('presence', {
  state: () => ({ online: false, lastSeen: null }),
  actions: {
    touch() {
      this.online = true;
      this.lastSeen = Date.now();
    },
  },
});
