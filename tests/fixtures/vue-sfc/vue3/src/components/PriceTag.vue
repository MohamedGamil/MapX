<template>
  <span class="price-tag">{{ amount }} {{ currency }}</span>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ amount: number; currency?: string }>(), { currency: 'EUR' });
</script>
