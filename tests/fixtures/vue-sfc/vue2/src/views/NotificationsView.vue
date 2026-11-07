<template>
  <section class="notifications">
    <h1>Notifications</h1>
    <button type="button" @click="backHome">Back to dashboard</button>
  </section>
</template>

<script>
export default {
  name: 'NotificationsView',
  methods: {
    backHome() {
      this.$router.push({ name: 'Dashboard' });
    },
  },
};
</script>
