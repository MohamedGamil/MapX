<template>
  <section class="cart">
    <ul>
      <li v-for="item in cart.items" :key="item.id" :aria-label="lineLabel(item)">
        {{ item.name }}
        <QuantityInput v-model="item.quantity" :max="10" />
      </li>
    </ul>
    <p>{{ format(cart.total) }}</p>
    <BaseButton variant="secondary" @click="emptyCart">Empty cart</BaseButton>
    <BaseButton @click="checkout">Checkout</BaseButton>
  </section>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router';
import QuantityInput from '../components/QuantityInput.vue';
import { useCartStore } from '../stores/cart';
import { useCurrency } from '../composables/useCurrency';

const router = useRouter();
const cart = useCartStore();
const { format } = useCurrency('EUR');

function lineLabel(item: { name: string; quantity: number }) {
  return `${item.quantity} × ${item.name}`;
}

function emptyCart() {
  cart.clear();
}

async function checkout() {
  await cart.checkout();
  router.push({ name: 'order-confirmation' });
}
</script>
