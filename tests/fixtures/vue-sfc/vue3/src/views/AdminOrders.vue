<template>
  <section class="admin-orders">
    <BaseButton variant="secondary" @click="backToCart">Back to cart</BaseButton>
    <BaseButton variant="link" @click="reopen">Reopen last</BaseButton>
  </section>
</template>

<script setup lang="ts" generic="T extends Record<string, unknown>">
import { useRouter } from 'vue-router';

defineProps<{ rows: T[] }>();

// Destructured from the router (M3-11-R1).
const { push } = useRouter();
// Destructured from a plain object: not the router.
const recent = { push: (path: string) => path };
const { push: remember } = recent;

function backToCart() {
  push({ name: 'cart' });
}

function reopen() {
  remember('/orders');
}
</script>
