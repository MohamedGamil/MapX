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
 * Ignore lists with the folders they apply to (workspace-relative, '' = every file). A framework
 * activated by a sub-folder manifest ignores its symbols only under that folder, so a Vue sub-app
 * does not drop a PHP backend's `t()` (M3-07). Plain data, so it reaches the parse workers as is.
 */
export type ScopedIgnoredSymbols = Array<{ scopes: string[]; symbols: Set<string> }>;

/** `scopes` maps a framework name to its folders; a framework missing from it applies everywhere. */
export function buildScopedIgnoredSymbols(activeFrameworks: string[], scopes?: Map<string, string[]>): ScopedIgnoredSymbols {
  const scoped: ScopedIgnoredSymbols = [];
  for (const name of activeFrameworks) {
    const symbols = IGNORED_SYMBOLS_BY_FRAMEWORK[name];
    if (symbols) scoped.push({ scopes: scopes?.get(name) ?? [''], symbols });
  }
  return scoped;
}

/** The merged ignore set for one workspace-relative file, or undefined when nothing applies. */
export function ignoredSymbolsForFile(scoped: ScopedIgnoredSymbols | undefined, filePath: string): Set<string> | undefined {
  const sets = (scoped ?? [])
    .filter(e => e.scopes.some(scope => scope === '' || filePath.startsWith(`${scope}/`)))
    .map(e => e.symbols);
  if (sets.length <= 1) return sets[0];
  return new Set(sets.flatMap(s => [...s]));
}

/**
 * Get the registry so callers can inspect or extend it at runtime.
 */
export function getIgnoredSymbolsRegistry(): Record<string, Set<string>> {
  return IGNORED_SYMBOLS_BY_FRAMEWORK;
}
