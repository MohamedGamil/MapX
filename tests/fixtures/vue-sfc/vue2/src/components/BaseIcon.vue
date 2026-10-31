<template>
  <i :class="['icon', `icon-${name}`]" aria-hidden="true" />
</template>

<script>
export default {
  name: 'BaseIcon',
  props: {
    name: { type: String, required: true },
  },
};
</script>
