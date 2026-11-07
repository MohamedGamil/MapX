// The dashboard screenshots on the landing page (M7-07): file, size, alt text and caption in one place,
// read by the generator, by site-facts.ts (and so the landing page) and by the tests. No imports, so
// VitePress-side code and tests can use it without the dashboard or Playwright.

export const SHOT_WIDTH = 1280;
export const SHOT_HEIGHT = 800;
/** The size cap of one image, in bytes. */
export const SHOT_MAX_BYTES = 150 * 1024;

export interface Screenshot {
  id: 'graph' | 'architecture' | 'http';
  /** File name under site/public/img/. */
  file: string;
  width: number;
  height: number;
  /** What the picture shows, for a reader who cannot see it. */
  alt: string;
  caption: string;
}

export const SCREENSHOTS: readonly Screenshot[] = [
  {
    id: 'graph',
    file: 'dashboard-graph.webp',
    width: SHOT_WIDTH,
    height: SHOT_HEIGHT,
    alt: 'The MapX dashboard Graph Explorer: a layered map of a TypeScript project\'s code clusters, joined by arrows labelled with their dependency counts.',
    caption: 'Explore the code graph: files, classes and calls as an interactive map.',
  },
  {
    id: 'architecture',
    file: 'dashboard-architecture.webp',
    width: SHOT_WIDTH,
    height: SHOT_HEIGHT,
    alt: 'The MapX dashboard Architecture view, Layer rules: health tiles for violations, baseline debt and uncovered code, above the start of a layer diagram.',
    caption: 'See the architecture rules at work: layers, violations and baseline debt.',
  },
  {
    id: 'http',
    file: 'dashboard-http.webp',
    width: SHOT_WIDTH,
    height: SHOT_HEIGHT,
    alt: 'The MapX dashboard HTTP Calls view: a Vue frontend\'s axios requests paired with the Laravel routes they reach, and one call that matches no route.',
    caption: 'Pair frontend HTTP calls with the backend routes they reach.',
  },
];
