<template>
  <main class="home">
    <Dashboard :user-id="userId" />
    <SettingsPanel :user-id="userId" @saved="onSettingsSaved" />
    <TicketForm />
  </main>
</template>

<script>
import Dashboard from '../components/Dashboard.vue';
import SettingsPanel from '../components/SettingsPanel.vue';
import TicketForm from '../components/TicketForm.vue';

export default {
  name: 'HomeView',
  components: { Dashboard, SettingsPanel, TicketForm },
  data() {
    return { userId: 1 };
  },
  methods: {
    onSettingsSaved() {
      this.$root.$emit('toast', 'Settings saved');
    },
  },
};
</script>
