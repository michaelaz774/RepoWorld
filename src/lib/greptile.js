/**
 * Greptile integration — indexes the repo and asks for risky files.
 *
 * All calls go through the same-origin proxy at /api/greptile/v2/... (auth is
 * injected server-side; never send auth headers from the browser). Every
 * function degrades gracefully: with no key (`__HAS_GREPTILE__` unset/false)
 * or on any network/parse failure, callers get an empty-but-valid result and
 * can fall back to `mockRisks()` so the demo never hard-fails.
 *
 * See src/lib/types.js for shared shapes (RepoRef etc).
 */

/** @typedef {import('./types.js').RepoRef} RepoRef */

/**
 * @typedef {Object} Risk
 * @property {string} file        Repo-relative path
 * @property {number} risk_score  1..10 integer
 * @property {string} reason      One or two sentences of analysis
 */

const BASE = '/api/greptile/v2';
const POLL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 240000;

/** True only when a Greptile key was present at build time. */
export function greptileAvailable() {
  // eslint-disable-next-line no-undef
  return typeof __HAS_GREPTILE__ !== 'undefined' && !!__HAS_GREPTILE__;
}

/** @param {RepoRef} repo */
function repoBody(repo) {
  return {
    remote: 'github',
    repository: `${repo.owner}/${repo.repo}`,
    branch: repo.branch || 'main',
  };
}

/** @param {RepoRef} repo */
function repoId(repo) {
  const branch = repo.branch || 'main';
  return encodeURIComponent(`github:${branch}:${repo.owner}/${repo.repo}`);
}

/**
 * Kick off indexing for a repo. Safe to call repeatedly (Greptile dedupes).
 * @param {RepoRef} repo
 * @returns {Promise<{ok: boolean, status: string, error?: string}>}
 */
export async function indexRepo(repo) {
  if (!greptileAvailable()) {
    return { ok: false, status: 'unavailable', error: 'no Greptile key configured' };
  }
  try {
    const res = await fetch(`${BASE}/repositories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(repoBody(repo)),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, status: String(data.status || res.status), error: data.message || `HTTP ${res.status}` };
    }
    return { ok: true, status: String(data.status || data.response || 'submitted') };
  } catch (err) {
    return { ok: false, status: 'error', error: err && err.message ? err.message : String(err) };
  }
}

/**
 * Check indexing progress for a repo.
 * @param {RepoRef} repo
 * @returns {Promise<{status: string, filesProcessed: number, numFiles: number, done: boolean}>}
 */
export async function getIndexStatus(repo) {
  const fail = { status: 'error', filesProcessed: 0, numFiles: 0, done: false };
  if (!greptileAvailable()) return { ...fail, status: 'unavailable' };
  try {
    const res = await fetch(`${BASE}/repositories/${repoId(repo)}`);
    if (!res.ok) return { ...fail, status: `http-${res.status}` };
    const data = await res.json().catch(() => ({}));
    const status = String(data.status || 'unknown');
    const done = /^(completed|ready)$/i.test(status);
    return {
      status,
      filesProcessed: Number(data.filesProcessed) || 0,
      numFiles: Number(data.numFiles) || 0,
      done,
    };
  } catch {
    return fail;
  }
}

/**
 * Poll until indexing completes or times out. Never throws.
 * Indexing a small repo takes 3-5 minutes — callers should keep the UI alive.
 * @param {RepoRef} repo
 * @param {{timeoutMs?: number, onProgress?: (status: string, filesProcessed: number, numFiles: number) => void}} [opts]
 * @returns {Promise<{done: boolean, timedOut: boolean}>}
 */
export async function waitForIndex(repo, opts = {}) {
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  if (!greptileAvailable()) return { done: false, timedOut: false };
  try {
    for (;;) {
      const s = await getIndexStatus(repo);
      try {
        opts.onProgress?.(s.status, s.filesProcessed, s.numFiles);
      } catch { /* progress callbacks must not break polling */ }
      if (s.done) return { done: true, timedOut: false };
      if (Date.now() + POLL_MS > deadline) return { done: false, timedOut: true };
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } catch {
    return { done: false, timedOut: false };
  }
}

/**
 * Extract the first JSON array from free text that may contain markdown
 * fences, prose, or trailing commas. Exported for testing.
 * @param {string} text
 * @returns {Array<any>|null}
 */
export function extractJsonArray(text) {
  if (typeof text !== 'string' || !text) return null;
  // Drop markdown fence markers (```json, ```js, bare ```) but keep contents.
  const stripped = text.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '');
  const start = stripped.indexOf('[');
  if (start === -1) return null;

  // Walk from the first '[' tracking string state to find its matching ']'.
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  // Truncated output: fall back to first '[' .. last ']' in the text.
  const candidate = end !== -1
    ? stripped.slice(start, end + 1)
    : (stripped.lastIndexOf(']') > start ? stripped.slice(start, stripped.lastIndexOf(']') + 1) : null);
  if (!candidate) return null;

  for (const attempt of [candidate, candidate.replace(/,\s*([\]}])/g, '$1')]) {
    try {
      const parsed = JSON.parse(attempt);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* try next repair */ }
  }
  return null;
}

function clampScore(n, fallback = 5) {
  const num = Number(n);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(10, Math.max(1, Math.round(num)));
}

/** @param {RepoRef} repo */
async function runQuery(repo, content) {
  const res = await fetch(`${BASE}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ id: `msg-${Date.now()}`, role: 'user', content }],
      repositories: [repoBody(repo)],
      sessionId: `repo-world-${repo.owner}-${repo.repo}-${Date.now()}`,
      genius: true,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Ask Greptile for the riskiest files in the repo. Never throws; returns []
 * on hard failure (callers then use mockRisks with the real file list).
 * @param {RepoRef} repo
 * @param {{limit?: number, onProgress?: (stage: string) => void}} [opts]
 * @returns {Promise<Risk[]>}
 */
export async function queryRisks(repo, opts = {}) {
  const limit = typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : 10;
  if (!greptileAvailable()) return [];
  try {
    opts.onProgress?.('querying Greptile for risky files');
    const data = await runQuery(
      repo,
      'Return ONLY a JSON array, no prose, no markdown fence: [{"file": "<repo-relative path>", ' +
      `"risk_score": <1-10 integer>, "reason": "<one or two sentences>"}]. List the ${limit} files in ` +
      'this repository most likely to contain bugs or cause production incidents. Judge by ' +
      'complexity, error handling gaps, concurrency, and blast radius. Use exact repo-relative paths.'
    );

    const parsed = extractJsonArray(typeof data.message === 'string' ? data.message : '');
    if (parsed) {
      const risks = parsed
        .filter((e) => e && typeof e === 'object' && typeof e.file === 'string' && e.file &&
          Number.isFinite(Number(e.risk_score)))
        .map((e) => ({
          file: e.file.replace(/^\.?\//, ''),
          risk_score: clampScore(e.risk_score),
          reason: typeof e.reason === 'string' ? e.reason : 'Flagged as high-risk by code analysis.',
        }))
        .slice(0, limit);
      if (risks.length > 0) return risks;
    }

    // Free-text parse failed — synthesize risks from the structured sources[].
    if (Array.isArray(data.sources) && data.sources.length > 0) {
      const seen = new Set();
      const sources = data.sources
        .filter((s) => s && typeof s.filepath === 'string' && s.filepath)
        .filter((s) => {
          const p = s.filepath.replace(/^\.?\//, '');
          if (seen.has(p)) return false;
          seen.add(p);
          return true;
        })
        .sort((a, b) => (Number(a.distance) || 0) - (Number(b.distance) || 0));
      return sources.slice(0, limit).map((s, i) => ({
        file: s.filepath.replace(/^\.?\//, ''),
        risk_score: clampScore(9 - i),
        reason: typeof s.summary === 'string' && s.summary
          ? s.summary
          : 'Surfaced by code search as most relevant to bug risk in this repository.',
      }));
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * One query asking for a short repo description (HUD + skybox prompt).
 * @param {RepoRef} repo
 * @param {{onProgress?: (stage: string) => void}} [opts]
 * @returns {Promise<string>} '' on failure
 */
export async function querySummary(repo, opts = {}) {
  if (!greptileAvailable()) return '';
  try {
    opts.onProgress?.('asking Greptile for a repo summary');
    const data = await runQuery(
      repo,
      'In 2-3 plain sentences, describe what this repository does and its high-level ' +
      'architecture (main components and how they fit together). No lists, no markdown, no code.'
    );
    return typeof data.message === 'string' ? data.message.trim() : '';
  } catch {
    return '';
  }
}

/** Path-signal heuristics for the offline fallback. Order matters: first match wins the headline reason. */
const PATH_SIGNALS = [
  { re: /(^|[/._-])auth|login|oauth|jwt/i, score: 3, reason: 'Large auth module with many branches; token refresh paths are easy to get wrong.' },
  { re: /payment|billing|checkout|invoice/i, score: 3, reason: 'Payment-path code where partial failures and retries have real financial blast radius.' },
  { re: /crypt|token|secret|password/i, score: 3, reason: 'Credential and token handling; subtle mistakes here become security incidents.' },
  { re: /migrat/i, score: 2, reason: 'Schema/data migration logic; a mistake is destructive and hard to roll back.' },
  { re: /session/i, score: 2, reason: 'Session lifecycle handling; stale or leaked state tends to surface only under load.' },
  { re: /websocket|socket|realtime/i, score: 2, reason: 'Long-lived socket handling with reconnect and backpressure paths that rarely get tested.' },
  { re: /pars(e|er|ing)|lexer|tokeniz/i, score: 2, reason: 'Hand-rolled parsing with many input edge cases and easy off-by-one errors.' },
  { re: /queue|worker|concurren|thread|lock|mutex|async/i, score: 2, reason: 'Concurrent orchestration code; race conditions and dropped errors hide here.' },
  { re: /(^|[/._-])(db|database|sql|repo(sitor)?y|store)([/._-]|$)/i, score: 2, reason: 'Data-access layer; query building and transaction boundaries are common failure points.' },
  { re: /legacy|deprecated|old[/._-]/i, score: 2, reason: 'Legacy module with accumulated workarounds; changes here have unpredictable side effects.' },
  { re: /cache/i, score: 2, reason: 'Caching layer; invalidation bugs show up as stale data only in production.' },
  { re: /(^|[/._-])api|handler|controller|route/i, score: 1, reason: 'Externally-facing API surface; gaps in error handling become user-visible incidents.' },
  { re: /(^|[/._-])util|helpers?([/._-]|$)/i, score: 1, reason: 'Widely-imported utility module; small changes ripple across the whole codebase.' },
  { re: /(^|[/._-])state|reducer/i, score: 1, reason: 'Central state management; ordering and mutation bugs propagate to every consumer.' },
  { re: /config|settings|env/i, score: 1, reason: 'Configuration wiring; an inconsistency here fails at startup or, worse, silently.' },
];

const CODE_EXTS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'c', 'cc', 'cpp', 'cs', 'rb', 'php', 'swift', 'kt']);
const DATA_EXTS = new Set(['md', 'mdx', 'json', 'yml', 'yaml', 'lock', 'txt', 'svg', 'png', 'jpg', 'css', 'scss', 'html']);

/**
 * Deterministic offline risk scoring — no network, no randomness. This is
 * what runs on stage if the Greptile key is missing or the query fails.
 * @param {Array<{path?: string, size?: number}|string>} files  FileNode-ish objects or plain paths
 * @param {number} [limit]
 * @returns {Risk[]}
 */
export function mockRisks(files, limit = 10) {
  if (!Array.isArray(files) || files.length === 0) return [];
  const scored = [];
  for (const f of files) {
    const path = typeof f === 'string' ? f : (f && typeof f.path === 'string' ? f.path : '');
    if (!path) continue;
    const size = typeof f === 'object' && f && Number.isFinite(f.size) ? f.size : 0;
    const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
    const isTest = /(^|[/.])(test|spec)s?[/.]|\.(test|spec)\./i.test(path);

    let score = 2;
    let headline = '';
    let signalCount = 0;
    for (const sig of PATH_SIGNALS) {
      if (sig.re.test(path)) {
        score += sig.score;
        signalCount++;
        if (!headline) headline = sig.reason;
      }
    }
    if (size > 50000) score += 3;
    else if (size > 15000) score += 2;
    else if (size > 5000) score += 1;
    const depth = path.split('/').length - 1;
    if (depth >= 5) score += 2;
    else if (depth >= 3) score += 1;
    if (CODE_EXTS.has(ext)) score += 1;
    if (DATA_EXTS.has(ext)) score -= 2;
    if (isTest) score -= 3;

    let reason = headline;
    if (!reason) {
      reason = size > 15000
        ? `Large file (~${Math.round(size / 1024)} KB) with a wide surface area; complexity like this is where regressions cluster.`
        : 'Moderately complex module with several code paths and limited isolation from its neighbors.';
    } else if (size > 15000) {
      reason += ` At ~${Math.round(size / 1024)} KB it also carries an unusually broad surface area.`;
    }

    scored.push({
      file: path,
      risk_score: clampScore(score),
      reason,
      _sort: score + signalCount * 0.01, // stable pre-clamp tiebreak, stripped below
    });
  }
  scored.sort((a, b) => (b._sort - a._sort) || a.file.localeCompare(b.file));
  const n = typeof limit === 'number' && limit > 0 ? limit : 10;
  return scored.slice(0, n).map(({ file, risk_score, reason }) => ({ file, risk_score, reason }));
}
