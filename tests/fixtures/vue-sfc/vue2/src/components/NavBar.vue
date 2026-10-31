<template>
  <nav class="nav-bar">
    <router-link :to="{ name: 'tickets' }">Tickets</router-link>
    <!-- <legacy-banner message="The old helpdesk closes on Friday" /> -->
    <base-icon name="bell" @click.native="openNotifications" />
    <button type="button" @click="signOut">Sign out</button>
  </nav>
</template>

<script>
import LegacyBanner from './LegacyBanner.vue';
import { useSessionStore } from '../stores/session';

export default {
  name: 'NavBar',
  components: { LegacyBanner },
  methods: {
    openNotifications() {
      this.$router.push('/notifications');
    },
    signOut() {
      useSessionStore().logout();
    },
  },
};
</script>
