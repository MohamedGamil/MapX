// Pattern values of selectors (M5-03): globs, regexes and names, compiled once per pattern.
import picomatch from 'picomatch';

const patterns = new Map<string, (s: string) => boolean>();

/** `/body/flags` is a regex; anything else a glob (picomatch, dotfiles included). */
export function globOrRegex(pattern: string): (s: string) => boolean {
  const key = `g:${pattern}`;
  let fn = patterns.get(key);
  if (!fn) {
    const m = /^\/(.*)\/([a-z]*)$/s.exec(pattern);
    if (m) {
      const re = new RegExp(m[1]!, m[2]);
      fn = (s) => re.test(s);
    } else {
      const glob = picomatch(pattern, { dot: true });
      fn = (s) => glob(s);
    }
    patterns.set(key, fn);
  }
  return fn;
}

/** A regex, case-insensitive unless written `/body/flags` (AR-04). */
export function regex(pattern: string): (s: string) => boolean {
  const key = `r:${pattern}`;
  let fn = patterns.get(key);
  if (!fn) {
    const m = /^\/(.*)\/([a-z]*)$/s.exec(pattern);
    const re = m ? new RegExp(m[1]!, m[2]) : new RegExp(pattern, 'i');
    fn = (s) => re.test(s);
    patterns.set(key, fn);
  }
  return fn;
}

/** Exact (case-insensitive) unless the value is a glob. */
export function nameOrGlob(pattern: string): (s: string) => boolean {
  if (/[*?[\]{}]/.test(pattern)) {
    const key = `n:${pattern}`;
    let fn = patterns.get(key);
    if (!fn) {
      const glob = picomatch(pattern, { nocase: true, dot: true });
      fn = (s) => glob(s);
      patterns.set(key, fn);
    }
    return fn;
  }
  const lower = pattern.toLowerCase();
  return (s) => s.toLowerCase() === lower;
}
