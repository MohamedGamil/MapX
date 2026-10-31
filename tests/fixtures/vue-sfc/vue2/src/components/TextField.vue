<template>
  <label class="text-field">
    {{ label }}
    <input :value="value" @input="onInput" />
  </label>
</template>

<script>
export default {
  name: 'TextField',
  props: {
    value: { type: String, default: '' },
    label: { type: String, required: true },
  },
  methods: {
    onInput(event) {
      this.$emit('input', event.target.value);
    },
  },
};
</script>
