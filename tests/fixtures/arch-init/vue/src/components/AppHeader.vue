<!-- Synthetic fixture for M5-17-R1 (mapx arch init --preset vue). Not a real application. -->
<script setup lang="ts">
import { useOrdersStore } from "../stores/orders";

const orders = useOrdersStore();
</script>

<template>
  <header>{{ orders.count }}</header>
</template>
