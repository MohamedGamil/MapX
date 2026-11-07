<template>
  <div class="quantity-input">
    <button type="button" @click="step(-1)">-</button>
    <span>{{ modelValue }}</span>
    <button type="button" @click="step(1)">+</button>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ modelValue: number; max?: number }>();
const emit = defineEmits<{ (e: 'update:modelValue', value: number): void }>();

function step(delta: number) {
  const next = Math.min(Math.max(props.modelValue + delta, 1), props.max ?? 99);
  emit('update:modelValue', next);
}
</script>
