<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{ label: string; code: string }>();
const copied = ref(false);

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.code);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    /* clipboard unavailable: the text stays selectable */
  }
}
</script>

<template>
  <figure class="codeblock">
    <figcaption>
      <span>{{ label }}</span>
      <button type="button" :aria-label="`Copy: ${label}`" @click="copy">{{ copied ? 'Copied' : 'Copy' }}</button>
      <span class="sr-only" role="status">{{ copied ? 'Copied to the clipboard' : '' }}</span>
    </figcaption>
    <pre class="landing-code" role="region" :aria-label="label" tabindex="0"><code>{{ code }}</code></pre>
  </figure>
</template>

<style scoped>
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.codeblock {
  margin: 0;
  min-width: 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
  overflow: hidden;
}
figcaption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--vp-c-divider);
  font-size: 13px;
  font-weight: 600;
  color: var(--vp-c-text-2);
}
button {
  padding: 2px 10px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
button:hover {
  border-color: var(--mapx-brand);
}
button:focus-visible,
pre:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}
pre {
  margin: 0;
  padding: 14px;
  overflow-x: auto;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  line-height: 1.6;
  color: var(--vp-c-text-1);
}
</style>
