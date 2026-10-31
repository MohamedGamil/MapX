<template>
  <header class="app-header">
    <router-link :to="{ name: 'cart' }" class="cart-link">Cart</router-link>
    <!-- <PromoBanner :campaign="campaign" /> -->
    <BaseButton variant="ghost" v-on:click="logout">Sign out</BaseButton>
  </header>
</template>

<script>
import PromoBanner from './PromoBanner.vue';
import { useCartStore } from '../stores/cart';

export default {
  name: 'AppHeader',
  // Registered for the autumn campaign; the banner is commented out of the template for now.
  components: { PromoBanner },
  data() {
    return { campaign: 'autumn' };
  },
  methods: {
    logout() {
      useCartStore().clear();
      window.location.assign('/login');
    },
  },
};
</script>
