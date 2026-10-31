<template>
  <tr :class="{ selected }" :title="formatSubject(ticket.subject)" @click="open">
    <td>#{{ ticket.id }}</td>
    <td>{{ ticket.subject }}</td>
    <td><StatusBadge :status="ticket.status" /></td>
    <td>{{ age }}</td>
  </tr>
</template>

<script>
import StatusBadge from './StatusBadge.vue';
import timeAgo from '../mixins/timeAgo';

export default {
  name: 'TicketRow',
  components: { StatusBadge },
  mixins: [timeAgo],
  props: {
    ticket: { type: Object, required: true },
    selected: { type: Boolean, default: false },
  },
  computed: {
    age() {
      return this.relativeTime(this.ticket.createdAt);
    },
  },
  watch: {
    selected(value) {
      this.highlight(value);
    },
  },
  methods: {
    open() {
      this.$emit('open', this.ticket.id);
    },
    formatSubject(subject) {
      return this.truncate(subject, 40);
    },
    truncate(text, length) {
      return text.length > length ? `${text.slice(0, length - 1)}…` : text;
    },
    highlight(on) {
      if (on) this.$el.scrollIntoView({ block: 'nearest' });
    },
  },
};
</script>
