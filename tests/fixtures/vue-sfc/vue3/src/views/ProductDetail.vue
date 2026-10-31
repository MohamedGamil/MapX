<template>
  <section v-if="product" class="product-detail">
    <h1>{{ product.name }}</h1>
    <BaseButton variant="ghost" @click="saveForLater">Save for later</BaseButton>
  </section>
</template>

<script>
import { useRoute } from 'vue-router';
import { useProduct } from '../composables/useProduct';
import { useWishlistStore } from '../stores/wishlist';

export default {
  name: 'ProductDetail',
  setup() {
    const route = useRoute();
    const { product } = useProduct(route.params.id);
    const wishlist = useWishlistStore();

    function saveForLater() {
      wishlist.add(product.value);
    }

    return { product, saveForLater };
  },
};
</script>
