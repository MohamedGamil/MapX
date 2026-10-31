<template>
  <span :class="['badge', `badge-${status}`]">{{ status }}</span>
</template>

<script>
export default {
  name: 'StatusBadge',
  props: ['status'],
};
</script>
