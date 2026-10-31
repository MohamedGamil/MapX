<template>
  <form class="ticket-form" @submit.prevent="save">
    <text-field v-model="form.subject" label="Subject" />
    <text-field v-model="form.requester" label="Requester e-mail" />
    <button type="submit" :disabled="!canSave()">Create ticket</button>
  </form>
</template>

<script>
import TextField from './TextField.vue';

export default {
  name: 'TicketForm',
  components: { TextField },
  data() {
    return { form: { subject: '', requester: '' } };
  },
  methods: {
    canSave() {
      return this.form.subject.trim() !== '' && this.form.requester.includes('@');
    },
    async save() {
      if (!this.canSave()) return;
      await this.$store.dispatch('tickets/CREATE', { ...this.form });
      this.$router.push({ name: 'tickets' });
    },
  },
};
</script>
