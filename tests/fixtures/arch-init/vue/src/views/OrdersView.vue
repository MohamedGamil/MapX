<!-- Synthetic fixture for M5-17-R1 (mapx arch init --preset vue). Not a real application. -->
<script setup lang="ts">
import AppHeader from "../components/AppHeader.vue";
import { useOrderTotal } from "../composables/useOrderTotal";

const total = useOrderTotal();
</script>

<template>
  <AppHeader />
  <p>{{ total }}</p>
</template>
