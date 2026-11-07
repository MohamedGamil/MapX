import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// I19 / M0-19-R1: JSX element usage becomes `render` edges to the component's file.
describe('JSX render edges', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'src/LinksPage.tsx': 'export function LinksPage() { return <ul />; }\n',
      'src/Card.tsx': 'export default function Card(props: { title: string }) { return <div>{props.title}</div>; }\n',
      'src/Page.tsx': [
        "import { LinksPage } from './LinksPage';",
        "import Card from './Card';",
        'export function Page() {',
        '  return (<main><LinksPage /><Card title="x"></Card><Missing /></main>);',
        '}',
      ].join('\n'),
    });
    init(root);
    mapx(root, 'scan', root);
  }, 60000);
  afterAll(() => cleanup(root));

  const renders = () =>
    query<{ target_file: string; target_symbol: string | null }>(
      root,
      "SELECT target_file, target_symbol FROM edges WHERE source_file = 'src/Page.tsx' AND edge_type = 'render'",
    );

  it('links self-closing and paired JSX elements to their component files', () => {
    const targets = renders().map((e) => e.target_file).sort();
    expect(targets).toEqual(['src/Card.tsx', 'src/LinksPage.tsx']);
  });

  it('creates no render edge for an undefined component', () => {
    expect(renders().some((e) => e.target_symbol === 'Missing')).toBe(false);
  });
});
