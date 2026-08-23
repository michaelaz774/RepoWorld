/**
 * Dependency extraction + resolution — turns source files into DepEdge[]
 * (see src/lib/types.js for the DepEdge / FileNode contracts).
 *
 * Pure logic only; buildEdges takes an injected fetchContent so nothing here
 * touches the network directly.
 */

/** Extensions we treat as "code" worth fetching/parsing for imports. */
const CODE_EXTS = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'go', 'rs']);

/** Resolution order for extension inference on relative specifiers. */
const RESOLVE_EXTS = ['js', 'jsx', 'ts', 'tsx', 'py', 'go', 'rs'];
const INDEX_EXTS = ['js', 'jsx', 'ts', 'tsx'];

const JS_EXTS = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx']);

/** Cheaply strip comments from JS-ish source (good enough; ignores strings edge cases). */
function stripJsComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

/** Strip full-line # comments (Python) — cheap, leaves inline strings alone. */
function stripHashComments(src) {
  return src.replace(/^\s*#[^\n]*/gm, '');
}

/**
 * Extract raw import specifier strings from source content.
 * Never throws; returns [] for anything it can't handle.
 * @param {string} content
 * @param {string} ext lowercase extension without dot ("js", "py", ...)
 * @returns {string[]}
 */
export function extractImports(content, ext) {
  try {
    if (typeof content !== 'string' || !content) return [];
    const e = String(ext || '').toLowerCase();
    const out = [];
    const push = (s) => {
      if (s && typeof s === 'string') out.push(s);
    };

    if (JS_EXTS.has(e)) {
      const src = stripJsComments(content);
      let m;
      // import x from 'y' / import 'y' / import * as x from 'y' / import {a} from 'y'
      const importRe = /\bimport\s+(?:[^'"();]+?\s+from\s+)?['"]([^'"\n]+)['"]/g;
      while ((m = importRe.exec(src))) push(m[1]);
      // export ... from 'y'
      const exportRe = /\bexport\s+[^'";]*?\s+from\s+['"]([^'"\n]+)['"]/g;
      while ((m = exportRe.exec(src))) push(m[1]);
      // require('y')
      const requireRe = /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
      while ((m = requireRe.exec(src))) push(m[1]);
      // dynamic import('y')
      const dynRe = /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
      while ((m = dynRe.exec(src))) push(m[1]);
    } else if (e === 'py') {
      const src = stripHashComments(content);
      let m;
      // from y import z / from .y import z
      const fromRe = /^\s*from\s+([.\w]+)\s+import\b/gm;
      while ((m = fromRe.exec(src))) push(m[1]);
      // import y / import y as x / import a, b
      const importRe = /^\s*import\s+([\w. ,]+)/gm;
      while ((m = importRe.exec(src))) {
        for (const part of m[1].split(',')) {
          const name = part.trim().split(/\s+as\s+/)[0].trim();
          if (/^[\w.]+$/.test(name)) push(name);
        }
      }
    } else if (e === 'go') {
      const src = stripJsComments(content); // Go uses // and /* */ too
      let m;
      // grouped: import ( "a" \n alias "b" )
      const groupRe = /\bimport\s*\(([\s\S]*?)\)/g;
      while ((m = groupRe.exec(src))) {
        let q;
        const strRe = /"([^"\n]+)"/g;
        while ((q = strRe.exec(m[1]))) push(q[1]);
      }
      // single: import "a" / import alias "a"
      const singleRe = /\bimport\s+(?:\w+\s+)?"([^"\n]+)"/g;
      while ((m = singleRe.exec(src))) push(m[1]);
    } else if (e === 'rs') {
      const src = stripJsComments(content); // Rust uses // and /* */ too
      let m;
      // use a::b::c; / pub use a::b::{x, y}; — capture the path part before {, ;, or as
      const useRe = /^\s*(?:pub\s+)?use\s+([\w:]+)/gm;
      while ((m = useRe.exec(src))) push(m[1].replace(/::$/, ''));
    }

    // Dedupe, preserve order.
    return [...new Set(out)];
  } catch {
    return [];
  }
}

/** Normalize a path with . / .. segments; returns null if it escapes the root. */
function normalizePath(path) {
  const parts = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

/** All candidate paths for a base path: exact, +ext, /index.ext. */
function candidatesFor(base) {
  const c = [base];
  for (const e of RESOLVE_EXTS) c.push(`${base}.${e}`);
  for (const e of INDEX_EXTS) c.push(`${base}/index.${e}`);
  return c;
}

/**
 * Resolve an import specifier against the importing file's path into a concrete
 * repo path present in pathSet. Returns null if unresolved or ambiguous.
 * @param {string} spec
 * @param {string} fromPath
 * @param {Set<string>} pathSet
 * @returns {string|null}
 */
export function resolveSpecifier(spec, fromPath, pathSet) {
  try {
    if (!spec || typeof spec !== 'string' || !pathSet || typeof pathSet.has !== 'function') return null;
    // Strip query/hash suffixes ('./x?raw').
    const clean = spec.split(/[?#]/)[0];
    if (!clean) return null;

    if (clean.startsWith('./') || clean.startsWith('../')) {
      const fromDir = String(fromPath || '').split('/').slice(0, -1).join('/');
      const joined = normalizePath(fromDir ? `${fromDir}/${clean}` : clean);
      if (joined === null || joined === '') return null;
      for (const cand of candidatesFor(joined)) {
        if (pathSet.has(cand)) return cand;
      }
      return null;
    }

    // Bare specifier: try suffix matching against known repo paths.
    // Build normalized forms: raw, Rust a::b -> a/b, Python a.b -> a/b.
    const forms = new Set();
    forms.add(clean.replace(/^\/+/, ''));
    if (clean.includes('::')) forms.add(clean.replace(/::/g, '/'));
    if (!clean.includes('/') && clean.includes('.')) forms.add(clean.replace(/\./g, '/'));

    for (const form of forms) {
      if (!form) continue;
      for (const cand of candidatesFor(form)) {
        const matches = [];
        for (const p of pathSet) {
          if (p === cand || p.endsWith(`/${cand}`)) {
            matches.push(p);
            if (matches.length > 1) break;
          }
        }
        if (matches.length === 1 && matches[0] !== fromPath) return matches[0];
        if (matches.length > 1) return null; // ambiguous
      }
    }
    return null;
  } catch {
    return null;
  }
}

export const MAX_EDGES = 250;

/**
 * Build deduped, weighted DepEdge[] from file contents.
 * @param {import('./types.js').FileNode[]} files
 * @param {Map<string, string>} contents path -> source
 * @returns {import('./types.js').DepEdge[]}
 */
export function resolveEdges(files, contents) {
  try {
    if (!Array.isArray(files) || files.length === 0 || !contents || typeof contents.get !== 'function') return [];
    const pathSet = new Set(files.map((f) => f && f.path).filter(Boolean));
    /** @type {Map<string, {from: string, to: string}>} */
    const pairs = new Map();

    for (const f of files) {
      if (!f || !f.path) continue;
      const content = contents.get(f.path);
      if (typeof content !== 'string') continue;
      for (const spec of extractImports(content, f.ext)) {
        const to = resolveSpecifier(spec, f.path, pathSet);
        if (!to || to === f.path) continue;
        const key = `${f.path}\u0000${to}`;
        if (!pairs.has(key)) pairs.set(key, { from: f.path, to });
      }
    }

    // Weight: how many distinct files import each target, clamped to 1..5.
    const importCount = new Map();
    for (const { to } of pairs.values()) {
      importCount.set(to, (importCount.get(to) || 0) + 1);
    }

    const edges = [];
    for (const { from, to } of pairs.values()) {
      const weight = Math.max(1, Math.min(5, importCount.get(to) || 1));
      edges.push({ from, to, weight });
    }

    edges.sort((a, b) => b.weight - a.weight);
    return edges.slice(0, MAX_EDGES);
  } catch {
    return [];
  }
}

/**
 * Fetch content for the most central candidate files (concurrency 8) and
 * resolve edges. Never throws; returns [] on total failure.
 * @param {import('./types.js').FileNode[]} files
 * @param {(path: string) => Promise<string|null>} fetchContent
 * @param {{limit?: number, onProgress?: (done: number, total: number) => void}} [opts]
 * @returns {Promise<import('./types.js').DepEdge[]>}
 */
export async function buildEdges(files, fetchContent, opts = {}) {
  try {
    if (!Array.isArray(files) || files.length === 0 || typeof fetchContent !== 'function') return [];
    const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 120;

    const candidates = files
      .filter((f) => f && f.path && CODE_EXTS.has(String(f.ext || '').toLowerCase()))
      .sort((a, b) => (b.size || 0) - (a.size || 0))
      .slice(0, limit);
    if (candidates.length === 0) return [];

    const contents = new Map();
    const total = candidates.length;
    let done = 0;
    let next = 0;

    async function worker() {
      while (next < candidates.length) {
        const f = candidates[next++];
        try {
          const text = await fetchContent(f.path);
          if (typeof text === 'string') contents.set(f.path, text);
        } catch {
          // skip unfetchable file
        }
        done++;
        try {
          opts.onProgress?.(done, total);
        } catch {
          // progress callbacks must never break the pipeline
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(8, candidates.length) }, worker));
    return resolveEdges(files, contents);
  } catch {
    return [];
  }
}
