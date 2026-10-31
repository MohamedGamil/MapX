// Pairs frontend HTTP call sites with backend routes (docs/baton M2-06, contract D008).
import type { RouteBinding } from '../../types.js';
import type { HttpCallRecord } from './http-registry.js';

export type PairConfidence = 'exact' | 'parametric' | 'suffix';
export interface PairedRoute {
  method: string;
  path: string;
  handlerSymbol?: string;
  handlerFile: string;
  confidence: PairConfidence;
}

/** A route parameter in any backend syntax: {id}, {id?}, :id, :id?, <id>, <int:id>, or *. */
const isParam = (segment: string) => /^(\{[^}]*\}|:\w+\??|<[^>]+>|\*)$/.test(segment);
/** A route segment MapX could not evaluate (Laravel `{dynamic}`, M1-03-R1): unknown text, not a parameter. */
const isDynamic = (segment: string) => segment === '{dynamic}';

/** Method of a call whose method cannot be read from the code (e.g. `fetch(url, { method: verb })`). */
export const UNKNOWN_METHOD = 'UNKNOWN';

export interface PairOptions {
  /** The workspace's own hosts, besides local development hosts (M2-06-R1). */
  hosts?: Set<string>;
}

/** Development hosts that always belong to the workspace. */
const LOCAL_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])$|\.(?:localhost|test|local)$/;

/** Lower-case host (no port or credentials) of an absolute or protocol-relative URL, else null. */
export function urlHost(url: string): string | null {
  const m = url.match(/^(?:[a-z][a-z\d+.-]*:)?\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]+)/i);
  return m ? m[1]!.toLowerCase() : null;
}

/** Frameworks whose routes are client-side pages, never targets of an HTTP request. */
const CLIENT_ROUTERS = new Set(['vue-router', 'react-router', 'tanstack-router']);

/** Path segments of a request URL: no scheme/host, query or hash; empty segments dropped. */
export function urlSegments(url: string): string[] {
  const path = url.replace(/^(?:[a-z][a-z\d+.-]*:)?\/\/[^/]+/i, '').replace(/[?#].*$/, '');
  return path.split('/').filter(Boolean);
}

/** A route an HTTP request can reach: served by a backend, mounted and not overridden. */
const live = (r: RouteBinding) =>
  !CLIENT_ROUTERS.has(r.framework) &&
  r.metadata?.routeType !== 'client' &&
  r.metadata?.reachable !== false &&
  r.metadata?.overridden !== true;
const methodMatches = (route: string, call: string) => {
  const set = route.toUpperCase().split('|');
  return set.includes('ANY') || set.includes('ALL') || set.includes(call.toUpperCase());
};

/**
 * Score of a client path against a route path, or null when they cannot be the same request.
 * Literal = literal scores 2; a route parameter matches any client segment and scores 1; a
 * `{dynamic}` route segment matches any segment but is no evidence (0). An unknown client segment
 * (`{}`) matches only a route parameter: letting it match literals would pair any dynamic URL with
 * an arbitrary route of the same length. `literals` counts literal = literal segments.
 */
function matchScore(client: string[], route: string[]): { score: number; params: boolean; literals: number } | null {
  if (client.length !== route.length) return null;
  let score = 0;
  let params = false;
  let literals = 0;
  for (let i = 0; i < route.length; i++) {
    const c = client[i]!;
    const r = route[i]!;
    if (isDynamic(r)) params = true;
    else if (isParam(r)) {
      score += 1;
      params = true;
    } else if (c === r) {
      score += 2;
      literals++;
    } else return null;
  }
  return { score, params, literals };
}

/**
 * The live route a call reaches, or null when none serves it. A pair needs literal evidence: at
 * least one literal path segment equal on both sides (only `/` itself, with a known base, matches
 * without one). An absolute URL pairs only on a local or workspace host (`options.hosts`).
 */
export function pairCall(record: HttpCallRecord, routes: RouteBinding[], options: PairOptions = {}): PairedRoute | null {
  if (record.url === undefined || record.method.toUpperCase() === UNKNOWN_METHOD) return null;
  const host = urlHost(record.url);
  if (host && !LOCAL_HOST.test(host) && !options.hosts?.has(host)) return null;
  const client = urlSegments(record.url);
  let best: { route: RouteBinding; score: number; params: boolean; suffix: boolean } | null = null;
  for (const route of routes) {
    if (!live(route) || !methodMatches(route.method, record.method)) continue;
    const segments = urlSegments(route.path);
    // An unresolved base URL can stand for any leading segments: match the path as a suffix.
    const candidates = record.baseURLUnresolved && segments.length > client.length
      ? [{ segs: segments.slice(segments.length - client.length), suffix: true }]
      : [{ segs: segments, suffix: false }];
    for (const { segs, suffix } of candidates) {
      const m = matchScore(client, segs);
      if (!m || (!m.literals && (suffix || record.baseURLUnresolved || client.length > 0))) continue;
      // Ties: a full match beats a suffix match; otherwise the lexicographically smallest
      // (handler file, path) wins, so the result never depends on routes.json order.
      const key = `${route.handlerFile}\u0000${route.path}`;
      const bestKey = best ? `${best.route.handlerFile}\u0000${best.route.path}` : '';
      const better = !best || m.score > best.score ||
        (m.score === best.score && (best.suffix && !suffix || (best.suffix === suffix && key < bestKey)));
      if (better) best = { route, score: m.score, params: m.params, suffix };
    }
  }
  if (!best) return null;
  return {
    method: record.method.toUpperCase(),
    path: best.route.path,
    ...(best.route.handlerSymbol ? { handlerSymbol: best.route.handlerSymbol } : {}),
    handlerFile: best.route.handlerFile,
    confidence: best.suffix ? 'suffix' : best.params ? 'parametric' : 'exact',
  };
}
