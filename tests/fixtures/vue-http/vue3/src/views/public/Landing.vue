<script setup lang="ts">
// M2-06-R1: a source directory named public/ is still source.
const notices = await fetch('/api/notices/latest'); /* L45 */
</script>

<template>
  <section>{{ notices }}</section>
</template>
