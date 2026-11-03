// External targets `mapx arch allowed` can decide before any file uses them (review of M5-24-R3):
// the pre-flight case, "may I add this import?", names a package the manifest lists but no file
// imports yet, or a built-in no file uses yet, so the index holds no external element for it. This
// module makes one, the same as the scan would attribute the first reference: a package a manifest
// near the source (package.json, composer.json, requirements*.txt, pyproject.toml, go.mod; the
// source's folder up to the workspace root) lists, direct, dev when only a dev section lists it; or a
// built-in (`node:fs`, `python:os`, a Go standard-library path). Nothing else is invented: a package
// no manifest lists is still unknown.
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { Element, ExternalInfo, FileInfo } from './elements.js';
import { manifestRoots, nodeBuiltin } from '../core/manifests/npm.js';
import { composerRoots } from '../core/manifests/composer.js';
import { normalizeDist, parseRequirementsTxt, pyprojectRoots, pythonBuiltin } from '../core/manifests/pypi.js';
import { goBuiltin, parseGoMod } from '../core/manifests/go.js';
import { parseToml } from '../core/manifests/toml.js';

const ECOSYSTEMS = ['npm', 'composer', 'pypi', 'go'] as const;
type Ecosystem = typeof ECOSYSTEMS[number];
const NO_FILE: FileInfo = { path: '', repo: '', language: '', role: null, roleConfidence: 0, clusters: [], frameworkParts: new Set(), namespace: null };

interface Declared { ecosystem: Ecosystem; name: string; dev: boolean }

/** The packages the manifests from `fromPath`'s folder up to the workspace root list, nearest first. */
export function declaredPackages(root: string, fromPath: string | null): Declared[] {
  const dirs: string[] = [];
  for (let d = fromPath ? posix.dirname(fromPath) : '.'; ; d = posix.dirname(d)) {
    dirs.push(d === '' ? '.' : d);
    if (d === '.' || d === '' || d === '/') break;
  }
  const read = (dir: string, file: string): string | null => { try { return readFileSync(join(root, dir, file), 'utf8'); } catch { return null; } };
  const json = (text: string | null): unknown => { try { return text ? JSON.parse(text) : null; } catch { return null; } };
  const out: Declared[] = [];
  const add = (ecosystem: Ecosystem, prod: Iterable<string>, dev: Iterable<string>) => {
    const p = new Set(prod);
    for (const name of p) out.push({ ecosystem, name, dev: false });
    for (const name of dev) if (!p.has(name)) out.push({ ecosystem, name, dev: true });
  };
  for (const dir of dirs) {
    const pkg = json(read(dir, 'package.json'));
    if (pkg) { const r = manifestRoots(pkg); add('npm', r.prod, r.dev); }
    const composer = json(read(dir, 'composer.json'));
    if (composer) { const r = composerRoots(composer); add('composer', r.prod, r.dev); }
    const reqs = read(dir, 'requirements.txt');
    if (reqs) add('pypi', parseRequirementsTxt(reqs).requirements.map((r) => normalizeDist(r.name)), []);
    const pyproject = read(dir, 'pyproject.toml');
    if (pyproject) {
      try { const r = pyprojectRoots(parseToml(pyproject)); add('pypi', [...r.prod.keys()].map(normalizeDist), [...r.dev.keys()].map(normalizeDist)); } catch { /* not TOML */ }
    }
    const gomod = read(dir, 'go.mod');
    if (gomod) { try { add('go', parseGoMod(gomod).requires.keys(), []); } catch { /* not a go.mod */ } }
  }
  return out;
}

const element = (info: ExternalInfo): Element => ({
  id: `external:${info.ecosystem}:${info.origin}:${info.name}:${info.direct}:${info.dev}`,
  kind: 'external', qualifiedName: info.name, file: NO_FILE, topLevel: true, external: info,
});

/** The manifest-listed package a query names (`lodash`, `npm:lodash`), as an external element, or null. */
export function declaredPackage(root: string, query: string, fromPath: string | null): Element | null {
  const m = /^(npm|composer|pypi|go):(.+)$/.exec(query);
  const ecosystem = m?.[1] as Ecosystem | undefined;
  const name = m ? m[2]! : query;
  const match = (d: Declared) => (!ecosystem || d.ecosystem === ecosystem)
    && (d.ecosystem === 'pypi' ? d.name === normalizeDist(name) : d.ecosystem === 'composer' ? d.name === name.toLowerCase() : d.name === name);
  const hit = declaredPackages(root, fromPath).find(match);
  return hit ? element({ ecosystem: hit.ecosystem, origin: 'package', name: hit.name, package: hit.name, direct: true, dev: hit.dev }) : null;
}

/** The built-in a query names (`node:fs`, `npm:node:fs`, `python:os`, `go:net/http`), as an external element, or null. */
export function declaredBuiltin(query: string): Element | null {
  const m = /^(npm|pypi|go):(.+)$/.exec(query);
  const ecosystem = m?.[1];
  const name = m ? m[2]! : query;
  const builtin = (eco: string, pkg: string): Element => element({ ecosystem: eco, origin: 'builtin', name: pkg, package: pkg, direct: null, dev: null });
  if ((!ecosystem || ecosystem === 'npm') && name.startsWith('node:') && nodeBuiltin(name)) return builtin('npm', nodeBuiltin(name)!);
  if ((!ecosystem || ecosystem === 'pypi') && name.startsWith('python:') && pythonBuiltin(name.slice(7))) return builtin('pypi', pythonBuiltin(name.slice(7))!);
  if (ecosystem === 'go' && goBuiltin(name) === 'builtin') return builtin('go', name);
  return null;
}
