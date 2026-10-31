<template>
  <article v-if="ticket" class="ticket-detail">
    <h1><BaseIcon name="ticket" /> {{ ticket.subject }}</h1>
    <ReplyBox :ticket-id="ticket.id" @sent="reply" />
  </article>
</template>

<script>
import ReplyBox from '../components/ReplyBox.vue';
import { useTicket } from '../composables/useTicket';

export default {
  name: 'TicketDetail',
  components: { ReplyBox },
  props: {
    id: { type: [String, Number], required: true },
  },
  setup(props) {
    const { ticket, addReply } = useTicket(props.id);

    function reply(body) {
      addReply(body);
    }

    return { ticket, reply };
  },
};
</script>
