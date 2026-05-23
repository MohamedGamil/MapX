/**
 * Framework-specific symbol ignore lists.
 *
 * Each key is a framework name (matching FrameworkDetector.name) or a language
 * name (matching LanguageDefinition.name). When a framework or language is
 * active for the project being scanned, parsers can look up the corresponding
 * set and skip those symbols/references to keep the code graph clean.
 *
 * To add support for a new framework or language:
 *   1. Add a new entry to IGNORED_SYMBOLS_BY_FRAMEWORK below.
 *   2. The key should match the detector's `name` field or the language name.
 *   3. The scanner will automatically pick it up — no parser changes needed.
 */

const IGNORED_SYMBOLS_BY_FRAMEWORK: Record<string, Set<string>> = {
  // Vue ecosystem — detected via VueRouterDetector (name: 'vue-router')
  'vue-router': new Set([
    // Vue Core & Composition API
    'ref', 'computed', 'reactive', 'watch', 'watchEffect',
    'defineComponent', 'setup', 'onMounted', 'onUnmounted',
    'onBeforeMount', 'onBeforeUnmount', 'onUpdated', 'onBeforeUpdate',
    'provide', 'inject', 'nextTick', 'defineProps', 'defineEmits',
    'defineExpose', 'defineModel', 'defineOptions', 'withDefaults',
    'toRef', 'toRefs', 'unref', 'isRef', 'isReactive', 'isProxy',
    'shallowRef', 'shallowReactive', 'readonly', 'markRaw',
    // Vue Router
    'useRoute', 'useRouter', 'createRouter', 'createWebHistory',
    // Pinia
    'useStore', 'defineStore', 'storeToRefs',
    // Vue I18n
    'useI18n', 't', 'te', 'tm', 'rt', 'd', 'n',
    // Nuxt / VueUse
    'useHead', 'useMeta', 'useFetch', 'useAsyncData',
  ]),
};

/**
 * Build a merged ignore set from a list of active framework/language names.
 *
 * This is called once per scan pass and the result is forwarded through
 * parse options so each parser invocation does not need to re-compute it.
 */
export function buildIgnoredSymbols(activeFrameworks: string[]): Set<string> {
  const merged = new Set<string>();
  for (const name of activeFrameworks) {
    const symbols = IGNORED_SYMBOLS_BY_FRAMEWORK[name];
    if (symbols) {
      for (const s of symbols) merged.add(s);
    }
  }
  return merged;
}

/**
 * Get the registry so callers can inspect or extend it at runtime.
 */
export function getIgnoredSymbolsRegistry(): Record<string, Set<string>> {
  return IGNORED_SYMBOLS_BY_FRAMEWORK;
}
