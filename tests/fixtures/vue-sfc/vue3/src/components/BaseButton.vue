<template>
  <button :class="['btn', `btn-${variant}`]" @click="emit('click', $event)">
    <slot />
  </button>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ variant?: string }>(), { variant: 'primary' });
const emit = defineEmits<{ (e: 'click', event: MouseEvent): void }>();
</script>
