<template>
  <div class="reply-box">
    <textarea v-model="draft" :placeholder="placeholderFor(ticketId)" />
    <button type="button" :disabled="!draft" @click="send">Send reply</button>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{ ticketId: number; internal?: boolean }>();
const emit = defineEmits<{ (e: 'sent', body: string): void }>();
const draft = ref('');

function placeholderFor(id: number) {
  return props.internal ? `Internal note on #${id}` : `Reply to #${id}`;
}

function send() {
  emit('sent', draft.value);
  draft.value = '';
}
</script>
