<template>
  <section class="order-list">
    <BaseButton @click="refresh">Refresh</BaseButton>
    <ol>
      <li v-for="order in orders" :key="order.id">{{ order.number }}</li>
    </ol>
  </section>
</template>

<script>
export default {
  name: 'OrderList',
  computed: {
    orders() {
      return this.$store.state.orders.list;
    },
  },
  mounted() {
    this.refresh();
  },
  methods: {
    refresh() {
      return this.$store.dispatch('orders/FETCH_ALL');
    },
  },
};
</script>
