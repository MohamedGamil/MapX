<template>
  <ul class="data-list">
    <slot :item="current" :select="pick" />
    <slot name="row" :refund="pick" />
    <slot name="footer" />
  </ul>
</template>

<script setup>
const current = null;

function pick() {}
</script>
