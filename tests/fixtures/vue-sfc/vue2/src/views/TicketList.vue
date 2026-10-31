<template>
  <section class="ticket-list">
    <button type="button" @click="refresh">Refresh</button>
    <table>
      <TicketRow
        v-for="ticket in openTickets"
        :key="ticket.id"
        :ticket="ticket"
        @open="openTicket"
      />
    </table>
  </section>
</template>

<script>
import { mapActions, mapGetters } from 'vuex';
import TicketRow from '../components/TicketRow.vue';

export default {
  name: 'TicketList',
  components: { TicketRow },
  computed: {
    ...mapGetters('tickets', ['openTickets']),
  },
  created() {
    this.FETCH_ALL();
  },
  methods: {
    ...mapActions('tickets', ['FETCH_ALL']),
    refresh() {
      return this.$store.dispatch('tickets/FETCH_ALL');
    },
    openTicket(id) {
      this.$router.push({ name: 'ticket-detail', params: { id } });
    },
  },
};
</script>
