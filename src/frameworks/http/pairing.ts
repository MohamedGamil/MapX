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

/** Frameworks whose routes are client-side pages, never targets of an HTTP request. */
const CLIENT_ROUTERS = new Set(['vue-router', 'react-router', 'tanstack-router']);

/** Path segments of a request URL: no scheme/host, query or hash; empty segments dropped. */
export function urlSegments(url: string): string[] {
  const path = url.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]+/i, '').replace(/[?#].*$/, '');
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
 * Literal = literal scores 2; a route parameter matches any client segment and scores 1. An
 * unknown client segment (`{}`) matches only a route parameter: letting it match literals would
 * pair any dynamic URL with an arbitrary route of the same length.
 */
function matchScore(client: string[], route: string[]): { score: number; params: boolean } | null {
  if (client.length !== route.length) return null;
  let score = 0;
  let params = false;
  for (let i = 0; i < route.length; i++) {
    const c = client[i]!;
    const r = route[i]!;
    if (isParam(r)) {
      score += 1;
      params = true;
    } else if (c === r) score += 2;
    else return null;
  }
  return { score, params };
}

/** The live route a call reaches, or null when none serves it. */
export function pairCall(record: HttpCallRecord, routes: RouteBinding[]): PairedRoute | null {
  if (record.url === undefined) return null;
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
      if (!m) continue;
      const better = !best || m.score > best.score || (m.score === best.score && !suffix && best.suffix);
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
