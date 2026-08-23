/**
 * Hazard engine — turns GitHub issues, open PRs, and Greptile risk findings
 * into physical dangers attached to specific buildings.
 *
 * Pure logic, no network, fully deterministic (same input -> same output).
 * See types.js for the Hazard typedef this module produces.
 *
 * @typedef {Object} RawIssue
 * @property {number} number
 * @property {string} title
 * @property {string} body
 * @property {string[]} labels
 * @property {number} comments
 * @property {string} createdAt   ISO date string
 * @property {string} url
 * @property {boolean} isPR
 * @property {string[]} changedFiles   Repo-relative paths (PRs only)
 *
 * @typedef {Object} Risk
 * @property {string} file        Repo-relative path from Greptile
 * @property {number} risk_score  1..10
 * @property {string} reason
 */

const MS_PER_DAY = 86400000;
const MAX_TOTAL_HAZARDS = 60;
const MAX_HAZARDS_PER_BUILDING = 3;
const TITLE_MAX = 60;

/** Extensions that make a slash-token look like a real code path. */
const CODE_EXTS = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'rs', 'go', 'java',
  'cpp', 'cc', 'cxx', 'hpp', 'c', 'h', 'cs', 'rb', 'php', 'swift', 'kt',
  'sh', 'bash', 'zsh', 'html', 'htm', 'css', 'scss', 'sass', 'less',
  'md', 'mdx', 'json', 'yml', 'yaml', 'toml', 'sql', 'vue', 'svelte',
]);

/** Common words that must never trigger a directory/module-word match. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'but', 'not', 'with', 'this', 'that', 'when',
  'from', 'have', 'has', 'are', 'was', 'were', 'will', 'can', 'cant',
  'you', 'your', 'our', 'all', 'any', 'get', 'set', 'add', 'fix', 'bug',
  'issue', 'error', 'fails', 'fail', 'failing', 'broken', 'break',
  'code', 'file', 'files', 'line', 'repo', 'branch', 'main', 'master',
  'test', 'tests', 'build', 'run', 'running', 'use', 'using', 'used',
  'new', 'old', 'app', 'src', 'lib', 'index', 'update', 'version',
  'should', 'would', 'could', 'does', 'doesnt', 'work', 'works',
  'working', 'after', 'before', 'into', 'over', 'under', 'more', 'some',
  'only', 'also', 'here', 'there', 'then', 'than', 'them', 'they',
]);

function asString(v) {
  return typeof v === 'string' ? v : '';
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** Strip diff-style / relative prefixes and surrounding punctuation from a path mention. */
function normalizePathMention(raw) {
  let s = asString(raw).trim();
  s = s.replace(/^[('"`[{<]+|[)'"`\]}>.,;:!?]+$/g, '');
  s = s.replace(/^\.\//, '').replace(/^[ab]\//, '').replace(/^\/+/, '');
  return s;
}

/** True if `mention` matches building id exactly or as a path-boundary suffix (either direction). */
function pathMatches(mention, buildingId) {
  if (!mention || !buildingId) return false;
  if (mention === buildingId) return true;
  if (buildingId.endsWith('/' + mention)) return true;
  if (mention.endsWith('/' + buildingId)) return true;
  return false;
}

/**
 * Rank candidate buildings for an issue/PR. Best match first.
 * Heuristic tiers (strongest to weakest):
 *  1. PR changedFiles matching a building id (exact, then suffix).
 *  2. Explicit path mentions in title/body (slash + code extension, or backtick/quoted).
 *  3. Bare filename mentions matching a building's name.
 *  4. Directory/module words matching a building's path segments.
 * @param {RawIssue} issue
 * @param {import('./types.js').Building[]} buildings
 * @returns {string[]} ranked Building.id[]
 */
export function matchIssueToPaths(issue, buildings) {
  if (!issue || !Array.isArray(buildings) || buildings.length === 0) return [];
  const byId = new Map();
  for (const b of buildings) {
    if (b && typeof b.id === 'string') byId.set(b.id, b);
  }
  const ids = [...byId.keys()].sort();
  const ranked = [];
  const seen = new Set();
  const push = (id) => {
    if (id && byId.has(id) && !seen.has(id)) { seen.add(id); ranked.push(id); }
  };

  // --- Tier 1: PR changedFiles (exact first, then suffix) ---
  const changed = Array.isArray(issue.changedFiles) ? issue.changedFiles.map(normalizePathMention) : [];
  for (const f of changed) if (byId.has(f)) push(f);
  for (const f of changed) {
    if (!f) continue;
    for (const id of ids) if (pathMatches(f, id)) push(id);
  }

  const text = asString(issue.title) + '\n' + asString(issue.body);

  // --- Tier 2: explicit path mentions ---
  const pathMentions = [];
  // backtick / quoted spans that look like paths
  const spanRe = /[`"']([^`"'\n]{1,200})[`"']/g;
  let m;
  while ((m = spanRe.exec(text)) !== null) {
    const s = normalizePathMention(m[1]);
    if (s.includes('/') && !s.includes(' ')) pathMentions.push(s);
  }
  // bare tokens with a slash and a code extension
  for (const tok of text.split(/\s+/)) {
    const s = normalizePathMention(tok);
    if (!s.includes('/')) continue;
    const ext = s.includes('.') ? s.slice(s.lastIndexOf('.') + 1).toLowerCase() : '';
    if (CODE_EXTS.has(ext)) pathMentions.push(s);
  }
  for (const p of pathMentions) if (byId.has(p)) push(p);
  for (const p of pathMentions) {
    if (!p) continue;
    for (const id of ids) if (pathMatches(p, id)) push(id);
  }

  // --- Tier 3: bare filename mentions ("websocket.ts") ---
  const nameToIds = new Map();
  for (const id of ids) {
    const b = byId.get(id);
    const name = asString(b.name || id.split('/').pop()).toLowerCase();
    if (!name) continue;
    if (!nameToIds.has(name)) nameToIds.set(name, []);
    nameToIds.get(name).push(id);
  }
  const fileTokenRe = /(?<![\w/.-])([\w.-]+\.[a-z0-9]{1,6})(?![\w/])/gi;
  const fileNames = [];
  while ((m = fileTokenRe.exec(text)) !== null) {
    const tok = m[1].toLowerCase();
    const ext = tok.slice(tok.lastIndexOf('.') + 1);
    if (CODE_EXTS.has(ext)) fileNames.push(tok);
  }
  for (const name of fileNames) {
    const matches = nameToIds.get(name);
    if (matches) for (const id of matches) push(id); // ids already sorted -> deterministic
  }

  // --- Tier 4: directory/module words ("auth", "parser", "websocket") ---
  const words = new Set(
    text.toLowerCase().split(/[^a-z0-9_]+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
  );
  if (words.size > 0) {
    const scored = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      const segs = id.toLowerCase().split('/');
      const last = segs[segs.length - 1];
      const stem = last.includes('.') ? last.slice(0, last.lastIndexOf('.')) : last;
      const parts = new Set([...segs.slice(0, -1), stem]);
      let score = 0;
      for (const part of parts) {
        if (part.length >= 3 && !STOP_WORDS.has(part) && words.has(part)) score++;
      }
      if (score > 0) scored.push([id, score]);
    }
    scored.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    for (const [id] of scored) push(id);
  }

  return ranked;
}

/**
 * Severity for an issue/PR, 1..10.
 *
 * Formula:
 *   base (from labels, highest wins):
 *     critical / security / p0 / blocker / urgent / crash  -> 8
 *     bug / regression / p1                                -> 6
 *     enhancement / feature / docs / chore / question ...  -> 2
 *     anything else / unlabeled                            -> 4
 *   + comment heat:  >=15 comments -> +2, >=5 -> +1
 *   + age heat:      >=120 days    -> +2, >=30 -> +1
 *   clamped to 1..10.
 * So a long-festering, contested critical maxes at 10, while a fresh,
 * quiet docs tweak sits at 2.
 * @param {RawIssue} issue
 * @param {number} [now]  ms epoch, for deterministic tests
 * @returns {number}
 */
export function severityForIssue(issue, now = Date.now()) {
  if (!issue) return 1;
  const labels = (Array.isArray(issue.labels) ? issue.labels : [])
    .map((l) => asString(l).toLowerCase());
  const has = (...keys) => labels.some((l) => keys.some((k) => l.includes(k)));

  let base = 4;
  if (has('critical', 'security', 'p0', 'blocker', 'urgent', 'crash')) base = 8;
  else if (has('bug', 'regression', 'p1')) base = 6;
  else if (has('enhancement', 'feature', 'docs', 'documentation', 'chore', 'question', 'good first issue')) base = 2;

  const comments = Number(issue.comments) || 0;
  const heat = comments >= 15 ? 2 : comments >= 5 ? 1 : 0;

  const age = ageInDays(issue.createdAt, now);
  const ageHeat = age >= 120 ? 2 : age >= 30 ? 1 : 0;

  return clamp(base + heat + ageHeat, 1, 10);
}

/**
 * Severity for a Greptile risk finding: its 1..10 score, clamped and rounded.
 * @param {Risk} risk
 * @returns {number}
 */
export function severityForRisk(risk) {
  const score = Number(risk && risk.risk_score);
  if (!Number.isFinite(score)) return 1;
  return clamp(Math.round(score), 1, 10);
}

function ageInDays(createdAt, now) {
  const t = Date.parse(asString(createdAt));
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / MS_PER_DAY));
}

function truncateTitle(s, max = TITLE_MAX) {
  const t = asString(s).trim();
  if (t.length <= max) return t || '(untitled)';
  return t.slice(0, max - 1).trimEnd() + '…';
}

/** Primary label to lead the reason with: the one driving severity, else the first. */
function primaryLabel(labels) {
  const list = (Array.isArray(labels) ? labels : []).map((l) => asString(l)).filter(Boolean);
  const priority = ['critical', 'security', 'p0', 'blocker', 'urgent', 'crash', 'bug', 'regression', 'p1'];
  for (const key of priority) {
    const hit = list.find((l) => l.toLowerCase().includes(key));
    if (hit) return hit;
  }
  return list[0] || 'unlabeled';
}

function issueReason(issue, age, repoWide) {
  const label = primaryLabel(issue.labels);
  const comments = Number(issue.comments) || 0;
  const head = `${label} — open ${age} day${age === 1 ? '' : 's'}, ${comments} comment${comments === 1 ? '' : 's'}.`;
  return repoWide
    ? `${head} No specific file matched — this one haunts the whole repo.`
    : head;
}

/**
 * Build the final Hazard[] for the world.
 * Deterministic: no randomness, all sorts have full tie-breakers. Pass `now`
 * (ms epoch) for reproducible ageDays; it defaults to Date.now().
 * @param {{issues?: RawIssue[], prs?: RawIssue[], risks?: Risk[], buildings?: import('./types.js').Building[], now?: number}} input
 * @returns {import('./types.js').Hazard[]}
 */
export function buildHazards({ issues = [], prs = [], risks = [], buildings = [], now = Date.now() } = {}) {
  const safeBuildings = (Array.isArray(buildings) ? buildings : [])
    .filter((b) => b && typeof b.id === 'string');
  const byId = new Map(safeBuildings.map((b) => [b.id, b]));
  const sortedIds = [...byId.keys()].sort();

  // Largest buildings first (by bounding volume), for repo-wide placement.
  const largestFirst = [...safeBuildings].sort((a, b) => {
    const va = (Number(a.w) || 1) * (Number(a.d) || 1) * (Number(a.height) || 1);
    const vb = (Number(b.w) || 1) * (Number(b.d) || 1) * (Number(b.height) || 1);
    return vb - va || (a.id < b.id ? -1 : 1);
  });

  /** @type {import('./types.js').Hazard[]} */
  const hazards = [];
  const unplaced = [];

  const addIssueLike = (item, kind) => {
    if (!item || typeof item.number !== 'number') return;
    const resolvedKind = item.isPR ? 'pr' : kind;
    const age = ageInDays(item.createdAt, now);
    const matches = matchIssueToPaths(item, safeBuildings);
    const hazard = {
      id: `${resolvedKind === 'pr' ? 'pr' : 'issue'}-${item.number}`,
      path: matches[0] || null,
      kind: resolvedKind,
      severity: severityForIssue(item, now),
      title: truncateTitle(item.title),
      reason: issueReason(item, age, matches.length === 0),
      url: asString(item.url) || null,
      number: item.number,
      ageDays: age,
      comments: Number(item.comments) || 0,
    };
    if (hazard.path) hazards.push(hazard);
    else unplaced.push(hazard);
  };

  for (const issue of Array.isArray(issues) ? issues : []) addIssueLike(issue, 'issue');
  for (const pr of Array.isArray(prs) ? prs : []) addIssueLike(pr, 'pr');

  // Distribute unplaced issues/PRs round-robin over the largest buildings so
  // nothing is silently dropped. (If there are zero buildings we have no
  // world at all, so hazards are dropped — path must never be null.)
  if (largestFirst.length > 0) {
    const slots = largestFirst.slice(0, Math.max(1, Math.min(8, largestFirst.length)));
    unplaced.forEach((h, i) => {
      h.path = slots[i % slots.length].id;
      hazards.push(h);
    });
  }

  // Greptile risks: exact building id match, else path-boundary suffix match; skip otherwise.
  const riskSeen = new Map();
  for (const risk of Array.isArray(risks) ? risks : []) {
    const file = normalizePathMention(risk && risk.file);
    if (!file) continue;
    let target = byId.has(file) ? file : null;
    if (!target) target = sortedIds.find((id) => pathMatches(file, id)) || null;
    if (!target) continue;
    const hazard = {
      id: `risk-${file}`,
      path: target,
      kind: 'risk',
      severity: severityForRisk(risk),
      title: truncateTitle(`Risky: ${file.split('/').pop()}`),
      reason: asString(risk.reason) || 'Flagged as risky by Greptile.',
      url: null,
      number: null,
      ageDays: 0,
      comments: 0,
    };
    const prev = riskSeen.get(hazard.id);
    if (!prev || hazard.severity > prev.severity) riskSeen.set(hazard.id, hazard);
  }
  hazards.push(...riskSeen.values());

  // Deterministic ordering: severity desc, then id asc.
  const orderCmp = (a, b) => b.severity - a.severity || (a.id < b.id ? -1 : 1);
  hazards.sort(orderCmp);

  // Cap per building at 3, keeping highest severity (list is already sorted).
  const perBuilding = new Map();
  const capped = [];
  for (const h of hazards) {
    const count = perBuilding.get(h.path) || 0;
    if (count >= MAX_HAZARDS_PER_BUILDING) continue;
    perBuilding.set(h.path, count + 1);
    capped.push(h);
  }

  // Cap total at 60, keeping highest severity.
  return capped.slice(0, MAX_TOTAL_HAZARDS);
}

/**
 * Quick aggregate stats for the HUD.
 * @param {import('./types.js').Hazard[]} hazards
 * @returns {{total: number, byKind: {issue: number, pr: number, risk: number}, maxSeverity: number, hottestPath: string|null}}
 */
export function hazardStats(hazards) {
  const list = Array.isArray(hazards) ? hazards.filter(Boolean) : [];
  const byKind = { issue: 0, pr: 0, risk: 0 };
  let maxSeverity = 0;
  const heat = new Map();
  for (const h of list) {
    if (byKind[h.kind] !== undefined) byKind[h.kind]++;
    const sev = Number(h.severity) || 0;
    if (sev > maxSeverity) maxSeverity = sev;
    if (h.path) heat.set(h.path, (heat.get(h.path) || 0) + sev);
  }
  let hottestPath = null;
  let hottest = -Infinity;
  for (const [path, total] of [...heat.entries()].sort()) {
    if (total > hottest) { hottest = total; hottestPath = path; }
  }
  return { total: list.length, byKind, maxSeverity, hottestPath };
}
