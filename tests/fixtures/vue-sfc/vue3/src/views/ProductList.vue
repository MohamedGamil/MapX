<template>
  <main class="product-list">
    <ProductCard
      v-for="product in visibleProducts"
      :key="product.id"
      :product="product"
      @click="goToProduct(product.id)"
    />
  </main>
</template>

<script>
import { mapActions, mapGetters } from 'vuex';
import ProductCard from '../components/ProductCard.vue';

export default {
  name: 'ProductList',
  components: { ProductCard },
  computed: {
    ...mapGetters('catalog', ['visibleProducts']),
  },
  created() {
    this.FETCH_PRODUCTS();
  },
  methods: {
    ...mapActions('catalog', ['FETCH_PRODUCTS']),
    goToProduct(id) {
      this.$router.push({ name: 'product-detail', params: { id } });
    },
  },
};
</script>
