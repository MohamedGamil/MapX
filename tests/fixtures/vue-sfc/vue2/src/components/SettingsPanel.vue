<template>
  <section class="settings-panel">
    <label>
      <input v-model="prefs.compact" type="checkbox" />
      Compact ticket list
    </label>
    <button type="button" @click="save">Save</button>
  </section>
</template>

<script setup>
import { usePreferences } from '../composables/usePreferences';
import { useSessionStore } from '../stores/session';

const props = defineProps({
  userId: { type: Number, required: true },
});
const emit = defineEmits(['saved']);

const { prefs, persist } = usePreferences(props.userId);
const session = useSessionStore();

async function save() {
  await persist();
  session.touch();
  emit('saved');
}
</script>
