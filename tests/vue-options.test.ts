import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';
import { analyzeOptionsComponent } from '../src/parsers/languages/vue-options.js';

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
      // Registers docs as the `docs` namespace; drafts also has publish() but is not registered (M3-05).
      'src/store/index.js': "import Vuex from 'vuex';\nimport docs from './docs';\nexport default new Vuex.Store({ modules: { docs } });\n",
      'src/store/drafts.js': 'export default {\n  namespaced: true,\n  actions: {\n    publish() { return 0; },\n  },\n};\n',
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

  it('resolves a map-helper name in the module registered under its namespace (M3-05)', () => {
    expect(targetsOf('submit', 'publish')).toEqual(['src/store/docs.js']);
  });
});

// M3-02-R1: `this` is the component only in the functions the options literal holds and in arrow
// functions inside them. A nested non-arrow function rebinds it, so its this.x() gets no edge.
describe('this.x() inside nested functions (M3-02-R1)', () => {
  const OPTIONS = `import { mapActions } from 'vuex';
export default {
  computed: {
    full: {
      get() { return this.format(); },
    },
  },
  watch: {
    title: { handler: function () { this.save(); } },
  },
  mixins: [{ methods: { mixed() { this.save(); } } }],
  methods: {
    ...mapActions(['load']),
    later() {
      setTimeout(function () { this.fetchAll(); }, 0);
      setTimeout(() => this.save(), 0);
    },
    withHelper() {
      const helper = { run: function () { this.save(); }, stop() { this.load(); } };
      function inner() { this.format(); }
      return [helper, inner];
    },
    quick: () => this.save(),
    save() {},
    format() {},
  },
};
`;

  it('splits component this.x() calls from rebound ones', async () => {
    const component = (await analyzeOptionsComponent(OPTIONS))!;
    const sort = (calls: { name: string; line: number }[]) => calls.map((c) => `${c.name}:${c.line}`).sort();
    expect(sort(component.thisCalls)).toEqual(['format:5', 'save:11', 'save:16', 'save:9']);
    expect(sort(component.reboundCalls)).toEqual(['fetchAll:15', 'format:20', 'load:19', 'save:19', 'save:23']);
  });

  it('never resolves a rebound this.x() by name to another file (real scan)', () => {
    const root = workspace({
      'package.json': JSON.stringify({ name: 'app', dependencies: { vue: '^2.7.16' } }),
      'src/components/Nest.vue': `<template><i /></template>
<script>
export default {
  methods: {
    later() {
      setTimeout(function () { this.fetchAll(); }, 0);
    },
    withHelper() {
      // \`this\` is helper here, not the component: neither the SFC's save() nor remote.js's.
      const helper = { run: function () { this.save(); }, stop() { this.notify(); } };
      return helper;
    },
    viaArrow() {
      return [1].map(() => this.save());
    },
    // Final review 2026-10-31: lodash wrappers and .bind(this) keep the component's this.
    onInput: debounce(function () { this.fetchItems(); }, 300),
    refreshLater() {
      setTimeout(function () { this.refresh(); }.bind(this), 0);
    },
    // socket.once calls back with the socket as this; Vue's $on with the component.
    listen(socket) {
      socket.once('connect', function () { this.join(); });
      this.$on('refresh', function () { this.reload(); });
    },
    save() {},
    fetchItems() {},
    refresh() {},
    join() {},
    reload() {},
  },
};
</script>
`,
      'src/api/remote.js': 'export function fetchAll() { return []; }\nexport function notify() { return 0; }\nexport function save() { return 1; }\n',
    });
    try {
      init(root);
      mapx(root, 'scan', root);
      const edges = query<{ source_symbol: string; target_file: string; target_symbol: string }>(root,
        `SELECT source_symbol, target_file, target_symbol FROM edges WHERE edge_type = 'call' AND source_file = 'src/components/Nest.vue' ORDER BY 1, 2, 3`)
        .map((e) => `${e.source_symbol} -> ${e.target_file}#${e.target_symbol}`);
      expect(edges).toEqual([
        // `onInput: debounce(…)` is a property, not a method: the component owns the call.
        'Nest -> src/components/Nest.vue#fetchItems',
        'listen -> src/components/Nest.vue#reload',
        'refreshLater -> src/components/Nest.vue#refresh',
        'viaArrow -> src/components/Nest.vue#save',
      ]);
    } finally {
      cleanup(root);
    }
  }, 120000);
});
