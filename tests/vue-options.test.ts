import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M3-03: `this.x()` in an Options API component resolves to the component's own member, then to a
// member of a mixin in its own `mixins: []` (in the mixin's file), and never to another file merely
// because that file defines `x` (edge contract rule 6, docs/baton/iterations/M3-01.md).
const EDITOR = 'src/components/Editor.vue';

describe('Vue Options API this.x() resolution', () => {
  let root: string;
  let calls: { source_symbol: string | null; target_file: string; target_symbol: string }[];
  const targetsOf = (source: string, target: string) =>
    calls.filter((e) => e.source_symbol === source && e.target_symbol === target).map((e) => e.target_file).sort();

  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'editor', dependencies: { vue: '^2.7.0', vuex: '^3.6.0' } }),
      [EDITOR]: `<template>
  <button @click="submit">{{ label }}</button>
</template>

<script>
import saving from '../mixins/saving';
import audited from '@/mixins/audited';
import { mapActions } from 'vuex';

export default {
  name: 'Editor',
  mixins: [audited, saving],
  props: { title: String, onDone: Function },
  computed: {
    label() {
      return this.format(this.title);
    },
  },
  watch: {
    title() {
      this.onDone();
    },
  },
  methods: {
    ...mapActions('docs', ['publish']),
    save() {
      this.persist();
      this.record('save');
    },
    format(text) {
      return text.trim();
    },
    submit() {
      this.save();
      this.publish();
      this.notify();
      this.validate();
    },
  },
};
</script>
`,
      // Listed after audited: its `record` overrides audited's, as in Vue's merge. Its `save` loses
      // to the component's own.
      'src/mixins/saving.js': `export default {
  methods: {
    save() { return 1; },
    persist() { return 2; },
    record(event) { return event; },
  },
};
`,
      'src/mixins/audited.js': `export default {
  methods: {
    record(event) { return ['audit', event]; },
  },
};
`,
      // Defines persist and validate but is not mixed in.
      'src/mixins/legacy.js': `export default {
  methods: {
    persist() { return 0; },
    validate() { return true; },
  },
};
`,
      'src/utils/notify.js': 'export function notify(message) { return message; }\nexport function onDone() { return 0; }\n',
      'src/store/docs.js': 'export default {\n  namespaced: true,\n  actions: {\n    publish() { return 1; },\n  },\n};\n',
      'src/components/Other.vue': '<script>\nexport default { methods: { save() { return 0; }, format(t) { return t; } } };\n</script>\n',
    });
    init(root);
    mapx(root, 'scan', '.');
    calls = query(root, `SELECT source_symbol, target_file, target_symbol FROM edges WHERE edge_type = 'call' AND source_file = ?`, EDITOR);
  }, 90000);
  afterAll(() => cleanup(root));

  it('resolves this.save() inside methods to the same SFC, over a mixin and another component', () => {
    expect(targetsOf('submit', 'save')).toEqual([EDITOR]);
    expect(targetsOf('label', 'format')).toEqual([EDITOR]);
  });

  it('resolves a mixin method through the component\'s own mixins array', () => {
    expect(targetsOf('save', 'persist')).toEqual(['src/mixins/saving.js']);
  });

  it('lets a later mixin override an earlier one', () => {
    expect(targetsOf('save', 'record')).toEqual(['src/mixins/saving.js']);
  });

  it('never resolves this.x() to a file merely because it defines x', () => {
    expect(targetsOf('submit', 'notify')).toEqual([]);
    expect(targetsOf('submit', 'validate')).toEqual([]);
    expect(targetsOf('title', 'onDone')).toEqual([]);
  });

  it('keeps map-helper names resolvable until M3-05 resolves their namespace', () => {
    expect(targetsOf('submit', 'publish')).toEqual(['src/store/docs.js']);
  });
});
