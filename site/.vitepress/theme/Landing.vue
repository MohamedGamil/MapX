<script setup lang="ts">
import { withBase } from 'vitepress';
import facts from '../facts.json';
import CodeBlock from './components/CodeBlock.vue';

const stats = [
  { label: 'MCP tools', value: facts.mcpTools },
  { label: 'Languages', value: facts.languages.length },
  { label: 'Framework detectors', value: facts.frameworks },
  { label: 'Architecture presets', value: facts.presets },
];

const cards = [
  {
    title: 'One local index of your code',
    text: `Symbols, imports, calls, inheritance, routes and HTTP calls from ${facts.languages.length} languages, kept in SQLite under .mapx/. Nothing leaves your machine.`,
    link: '/docs/getting-started',
    more: 'Getting started',
  },
  {
    title: 'Answers instead of file reads',
    text: `Agents ask for signatures, callers, dependencies and blast radius through ${facts.mcpTools} MCP tools, which costs far fewer tokens than reading the files.`,
    link: '/docs/mcp-integration',
    more: 'MCP integration',
  },
  {
    title: 'Fast and incremental',
    text: 'A pool of parse workers indexes large repositories, and mapx sync re-parses only what git or the content hashes say changed.',
    link: '/docs/cli-reference',
    more: 'CLI reference',
  },
  {
    title: 'Architecture rules in CI',
    text: 'Declare layers in .mapx/architecture.jsonc and mapx check fails the build on a forbidden dependency, with SARIF, GitHub, GitLab and JUnit reports.',
    link: '/docs/architecture-rules',
    more: 'Architecture rules',
  },
];
</script>

<template>
  <div class="landing">
    <section class="band" aria-label="MapX in numbers">
      <dl class="stats">
        <div v-for="s in stats" :key="s.label">
          <dt>{{ s.label }}</dt>
          <dd>{{ s.value }}</dd>
        </div>
      </dl>
    </section>

    <section class="band" aria-labelledby="what">
      <h2 id="what">What you get</h2>
      <div class="cards">
        <article v-for="c in cards" :key="c.title" class="card">
          <h3>{{ c.title }}</h3>
          <p>{{ c.text }}</p>
          <a :href="withBase(c.link)">{{ c.more }} →</a>
        </article>
      </div>
    </section>

    <section class="band" aria-labelledby="see">
      <h2 id="see">See it</h2>
      <p class="lead">The dashboard that <code>mapx ui</code> serves from your own machine.</p>
      <div class="shots">
        <figure v-for="s in facts.screenshots" :key="s.id" :data-shot="s.id">
          <!-- The pictures are shown at about half size on a wide screen: the link opens the full-size file. -->
          <a :href="withBase(`/img/${s.file}`)" target="_blank" rel="noopener" :aria-label="`Open the full-size picture: ${s.caption}`">
            <img
              :src="withBase(`/img/${s.file}`)"
              :alt="s.alt"
              :width="s.width"
              :height="s.height"
              loading="lazy"
              decoding="async"
            />
          </a>
          <figcaption>{{ s.caption }}</figcaption>
        </figure>
      </div>
    </section>

    <section class="band" aria-labelledby="try">
      <h2 id="try">Install and try it</h2>
      <p class="lead">Install once, then index any repository and ask the graph.</p>
      <div class="blocks">
        <CodeBlock label="Install" :code="facts.install.npm" />
        <CodeBlock label="Or run without installing" :code="facts.install.npx" />
        <div class="block-with-note">
          <CodeBlock label="Index a project, ask questions, check the architecture" :code="facts.quickstart.join('\n')" />
          <p class="note">
            <code>UserService</code> and <code>findUser</code> are symbols of the README's sample project: use a
            name from your own code.
          </p>
        </div>
        <CodeBlock label="Connect an agent: Claude Desktop (claude_desktop_config.json)" :code="facts.mcpConfig" />
      </div>
    </section>

    <section class="band" aria-labelledby="langs">
      <h2 id="langs">{{ facts.languages.length }} languages</h2>
      <ul class="chips">
        <li v-for="l in facts.languages" :key="l.id" :data-lang="l.id">{{ l.name }}</li>
      </ul>
    </section>

    <section class="band" aria-labelledby="agents">
      <h2 id="agents">Works with your agent</h2>
      <p class="lead"><code>mapx init</code> writes the instructions and MCP configuration for the tools it finds.</p>
      <ul class="chips">
        <li v-for="a in facts.agents" :key="a.id" :data-agent="a.id">{{ a.name }}</li>
      </ul>
    </section>

    <section class="band cta" aria-label="Next steps">
      <a class="button" :href="withBase('/docs/getting-started')">Read the guides</a>
      <a class="button alt" href="https://github.com/MohamedGamil/mapx">Source on GitHub</a>
      <a class="button alt" href="https://www.npmjs.com/package/@mgamil/mapx">npm package</a>
    </section>
  </div>
</template>

<style scoped>
.landing {
  max-width: 1152px;
  margin: 0 auto;
  padding: 0 24px 64px;
}
.band {
  padding: 40px 0 0;
}
h2 {
  margin: 0 0 16px;
  border: 0;
  padding: 0;
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.lead {
  margin: 0 0 20px;
  color: var(--vp-c-text-2);
}
.stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
  margin: 0;
}
.stats div {
  padding: 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
  text-align: center;
}
.stats dd {
  margin: 0;
  font-size: 32px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--vp-c-brand-1);
}
.stats dt {
  order: 2;
  font-size: 13px;
  color: var(--vp-c-text-2);
}
.stats div {
  display: flex;
  flex-direction: column;
}
.cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.card {
  padding: 20px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
}
.card h3 {
  margin: 0 0 8px;
  font-size: 17px;
}
.card p {
  margin: 0 0 12px;
  color: var(--vp-c-text-2);
  line-height: 1.6;
}
.card a {
  font-weight: 600;
  color: var(--vp-c-brand-1);
}
.block-with-note {
  min-width: 0;
}
.note {
  margin: 8px 4px 0;
  font-size: 13px;
  color: var(--vp-c-text-2);
}
.shots {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
}
.shots figure {
  margin: 0;
  min-width: 0;
}
.shots figure:first-child {
  grid-column: 1 / -1;
}
.shots a {
  display: block;
  border-radius: 12px;
}
.shots a:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 3px;
}
.shots img {
  display: block;
  width: 100%;
  height: auto;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}
.shots figcaption {
  margin-top: 8px;
  font-size: 14px;
  color: var(--vp-c-text-2);
}
.blocks {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.chips li {
  margin: 0;
  padding: 4px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  background: var(--vp-c-bg-soft);
  font-size: 14px;
}
.cta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.button {
  display: inline-block;
  padding: 10px 20px;
  border-radius: 20px;
  background: var(--vp-button-brand-bg);
  color: var(--vp-button-brand-text);
  font-weight: 600;
  text-decoration: none;
}
.button:hover {
  background: var(--vp-button-brand-hover-bg);
}
.button.alt {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
}
.button.alt:hover {
  border-color: var(--mapx-brand);
}
@media (max-width: 720px) {
  .stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .cards {
    grid-template-columns: minmax(0, 1fr);
  }
  .shots {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
