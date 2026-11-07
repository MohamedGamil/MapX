<template>
  <article class="product-card" :title="formatPrice(product.price)">
    <h3>{{ product.name }}</h3>
    <price-tag :amount="discounted" currency="EUR" />
    <input v-model.number="quantity" type="number" min="1" />
    <button type="button" @click="addToCart">Add to cart</button>
  </article>
</template>

<script>
import PriceTag from './PriceTag.vue';
import trackable from '../mixins/trackable';
import formatting from '../mixins/formatting';

export default {
  name: 'ProductCard',
  components: { PriceTag },
  mixins: [trackable, formatting],
  props: {
    product: { type: Object, required: true },
  },
  emits: ['added'],
  data() {
    return { quantity: 1 };
  },
  computed: {
    discounted() {
      return this.applyDiscount(this.product.price);
    },
  },
  watch: {
    product() {
      this.resetQuantity();
    },
  },
  methods: {
    addToCart() {
      this.track('add-to-cart', this.product.id);
      this.$emit('added', { id: this.product.id, quantity: this.quantity });
      this.resetQuantity();
    },
    formatPrice(value) {
      return this.currency(value, 'EUR');
    },
    applyDiscount(price) {
      return this.product.onSale ? Math.round(price * 0.9) : price;
    },
    resetQuantity() {
      this.quantity = 1;
    },
  },
};
</script>
