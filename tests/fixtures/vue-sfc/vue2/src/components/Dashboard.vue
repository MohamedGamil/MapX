<template>
  <div class="dashboard-widget">
    <router-link to="/tickets">Open tickets</router-link>
  </div>
</template>

<script>
export default {
  name: 'Dashboard',
  props: ['userId'],
};
</script>
