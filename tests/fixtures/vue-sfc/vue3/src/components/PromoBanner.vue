<template>
  <aside class="promo">{{ campaign }}</aside>
</template>

<script setup lang="ts">
defineProps<{ campaign: string }>();
</script>
