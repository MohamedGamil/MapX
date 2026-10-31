<template>
  <table class="reply-table">
    <slot :remove="drop" />
  </table>
</template>

<script>
export default {
  name: 'ReplyTable',
  props: { rows: Array },
  methods: {
    drop() {},
  },
};
</script>
