/**
 * Fixes — the data layer behind the review panel. Turns one Hazard into a
 * FixReport: a plain explanation of what's wrong plus a concrete suggested
 * before/after code change, the way a human reviewer would read a PR.
 *
 * Same integration shape as greptile.js: calls go through the same-origin
 * proxy at /api/greptile/v2/query (auth injected server-side), ask for JSON
 * in the prompt, then defensively parse the response with a fall back to
 * `sources[]` when the model didn't return clean JSON. On any failure,
 * timeout, or missing key, everything degrades to `mockFix()` — deterministic,
 * offline, no network, no Math.random — so the demo never dead-ends.
 *
 * See src/lib/types.js for RepoRef/Hazard. See src/lib/greptile.js for the
 * sibling module this one mirrors.
 */

/** @typedef {import('./types.js').RepoRef} RepoRef */
/** @typedef {import('./types.js').Hazard} Hazard */

/**
 * The player-facing explanation of one hazard and its proposed fix.
 * @typedef {Object} FixReport
 * @property {string} title        Short human title for the fix, e.g. "Guard against a missing value — login.js"
 * @property {string} problem      1-2 sentences: what is actually wrong
 * @property {string} impact       1 sentence: why it matters / what breaks
 * @property {string[]} files      Repo-relative file path(s) the fix touches
 * @property {string} before       Short buggy code snippet (real syntax for the file's language)
 * @property {string} after        The fixed version of that same snippet
 * @property {string} explanation  2-3 plain-English sentences, no jargon, for a total beginner
 * @property {'greptile'|'heuristic'} confidence
 */

import { greptileAvailable } from './greptile.js';

const BASE = '/api/greptile/v2';
const DEFAULT_TIMEOUT_MS = 25000;

/* ------------------------------------------------------------------ */
/* Small pure helpers shared by mockFix + fetchFix                     */
/* ------------------------------------------------------------------ */

/** FNV-1a — deterministic per-hazard variety, no Math.random. Mirrors the
 *  approach in layout.js / Hazards.jsx. */
function hashStr(s) {
  let h = 2166136261;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function asStr(v) {
  return typeof v === 'string' ? v : '';
}

function nonEmpty(v, fallback) {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

function clampSeverity(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(10, Math.max(1, Math.round(v))) : 5;
}

function wordsFromStem(stem) {
  return String(stem || 'file').split(/[^a-zA-Z0-9]+/).filter(Boolean);
}
function camelish(stem) {
  const w = wordsFromStem(stem).map((s) => s.toLowerCase());
  if (!w.length) return 'run';
  return w[0] + w.slice(1).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('');
}
function snakeish(stem) {
  const w = wordsFromStem(stem).map((s) => s.toLowerCase());
  return w.length ? w.join('_') : 'run';
}
function pascalish(stem) {
  const w = wordsFromStem(stem).map((s) => s.toLowerCase());
  return w.length ? w.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('') : 'Run';
}

function firstSentences(text, n) {
  const parts = String(text || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const out = parts.slice(0, n).join(' ').trim();
  return out || String(text || '').trim();
}

/* ------------------------------------------------------------------ */
/* File-extension -> "language family" for the offline snippet library */
/* ------------------------------------------------------------------ */

const JS_EXTS = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx']);
const CSS_EXTS = new Set(['css', 'scss', 'sass', 'less']);
const CONFIG_EXTS = new Set(['json', 'yml', 'yaml', 'toml']);
const DOCS_EXTS = new Set(['md', 'mdx', 'txt']);

function familyForExt(ext) {
  const e = String(ext || '').toLowerCase();
  if (JS_EXTS.has(e)) return 'js';
  if (e === 'py') return 'py';
  if (e === 'go') return 'go';
  if (CSS_EXTS.has(e)) return 'css';
  if (CONFIG_EXTS.has(e)) return 'config';
  if (DOCS_EXTS.has(e)) return 'docs';
  return 'generic'; // rb, java, c/cpp/cs, php, swift, kt, sql, unknown/no ext, ...
}

/* ------------------------------------------------------------------ */
/* Code-bug pattern library (shared across js/py/go/generic families)   */
/* ------------------------------------------------------------------ */

const CODE_PATTERNS = ['null-check', 'error-handling', 'bounds-check', 'unsafe-input', 'resource-leak'];

const PATTERN_TITLE = {
  'null-check': 'Guard against a missing value',
  'error-handling': 'Handle the failure path',
  'bounds-check': 'Fix an off-by-one loop bound',
  'unsafe-input': 'Stop building queries from raw input',
  'resource-leak': 'Close the resource it opens',
};

const PATTERN_PROBLEM = {
  'null-check': 'it reads a nested field without ever checking that the parent object exists',
  'error-handling': 'it assumes the request always succeeds and never handles the failure path',
  'bounds-check': 'a loop is told to go one step past the end of the list',
  'unsafe-input': 'it builds a query by pasting raw user input straight into it instead of keeping the two separate',
  'resource-leak': 'it opens a file or connection and never closes it again',
};

const PATTERN_IMPACT = {
  'null-check': 'the app crashes the moment that field happens to be missing',
  'error-handling': 'a failed request looks like it succeeded, so users see broken or blank data with no explanation',
  'bounds-check': 'the program reads past the end of the list and crashes or returns garbage',
  'unsafe-input': 'someone can manipulate the query and read or change data they should never be able to touch',
  'resource-leak': 'the process slowly runs out of open files/connections until it stops responding',
};

const PATTERN_EXPLANATION = {
  'null-check': "The code assumed some piece of information would always be there, but sometimes it isn't — and when that happens, the program crashes. The fix adds a quick check first, so if that information is missing, the code handles it gracefully instead of crashing.",
  'error-handling': "The code asked for something and just trusted it would work, without ever checking whether it actually did. The fix adds a check for failure, so when something goes wrong the program notices and responds sensibly instead of pretending everything is fine.",
  'bounds-check': "A loop that repeats over a list was told to take one extra step past the very last item. The fix stops the loop exactly at the last real item, so it never reaches for something that isn't there.",
  'unsafe-input': "The code took text a person typed and used it directly to build a database question, so someone could type something sneaky and take control of that question. The fix keeps the person's text completely separate from the instructions, so it can never be mistaken for a command.",
  'resource-leak': "The code opened something, like a file, to use it, but never closed it afterward. Over time that piles up and slows down or stops the whole program. The fix makes sure it always gets closed, even if something goes wrong along the way.",
};

function jsSnippet(pattern, stem) {
  const fn = camelish(stem);
  switch (pattern) {
    case 'null-check':
      return {
        before: `function ${fn}(user) {\n  return user.profile.name.trim();\n}`,
        after: `function ${fn}(user) {\n  if (!user || !user.profile) return '';\n  return (user.profile.name || '').trim();\n}`,
      };
    case 'error-handling':
      return {
        before: `async function ${fn}() {\n  const res = await fetch('/api/${stem}');\n  return res.json();\n}`,
        after: `async function ${fn}() {\n  const res = await fetch('/api/${stem}');\n  if (!res.ok) throw new Error(\`HTTP \${res.status}\`);\n  try {\n    return await res.json();\n  } catch (err) {\n    console.error('${fn} failed:', err);\n    return null;\n  }\n}`,
      };
    case 'bounds-check':
      return {
        before: `function ${fn}(items) {\n  let total = 0;\n  for (let i = 0; i <= items.length; i++) {\n    total += items[i].value;\n  }\n  return total;\n}`,
        after: `function ${fn}(items) {\n  let total = 0;\n  for (let i = 0; i < items.length; i++) {\n    total += items[i].value;\n  }\n  return total;\n}`,
      };
    case 'unsafe-input':
      return {
        before: `app.get('/${stem}', (req, res) => {\n  db.query(\`SELECT * FROM users WHERE id = \${req.query.id}\`);\n});`,
        after: `app.get('/${stem}', (req, res) => {\n  db.query('SELECT * FROM users WHERE id = ?', [req.query.id]);\n});`,
      };
    default: // resource-leak
      return {
        before: `function ${fn}(path) {\n  const stream = fs.createReadStream(path);\n  stream.on('data', handle);\n}`,
        after: `function ${fn}(path) {\n  const stream = fs.createReadStream(path);\n  stream.on('data', handle);\n  stream.on('end', () => stream.close());\n  stream.on('error', () => stream.close());\n}`,
      };
  }
}

function pySnippet(pattern, stem) {
  const fn = snakeish(stem);
  switch (pattern) {
    case 'null-check':
      return {
        before: `def ${fn}(user):\n    return user["profile"]["name"].strip()`,
        after: `def ${fn}(user):\n    if not user or not user.get("profile"):\n        return ""\n    return (user["profile"].get("name") or "").strip()`,
      };
    case 'error-handling':
      return {
        before: `def ${fn}():\n    try:\n        return fetch_data("${stem}")\n    except Exception:\n        pass`,
        after: `def ${fn}():\n    try:\n        return fetch_data("${stem}")\n    except requests.RequestException as exc:\n        logger.error("${fn} failed: %s", exc)\n        return None`,
      };
    case 'bounds-check':
      return {
        before: `def ${fn}(items):\n    total = 0\n    for i in range(len(items) + 1):\n        total += items[i]["value"]\n    return total`,
        after: `def ${fn}(items):\n    total = 0\n    for i in range(len(items)):\n        total += items[i]["value"]\n    return total`,
      };
    case 'unsafe-input':
      return {
        before: `def ${fn}(user_id):\n    cursor.execute("SELECT * FROM users WHERE id = %s" % user_id)`,
        after: `def ${fn}(user_id):\n    cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))`,
      };
    default: // resource-leak
      return {
        before: `def ${fn}(path):\n    f = open(path)\n    return f.read()`,
        after: `def ${fn}(path):\n    with open(path) as f:\n        return f.read()`,
      };
  }
}

function goSnippet(pattern, stem) {
  const fn = pascalish(stem);
  switch (pattern) {
    case 'null-check':
      return {
        before: `func ${fn}(u *User) string {\n\treturn strings.TrimSpace(u.Profile.Name)\n}`,
        after: `func ${fn}(u *User) string {\n\tif u == nil || u.Profile == nil {\n\t\treturn ""\n\t}\n\treturn strings.TrimSpace(u.Profile.Name)\n}`,
      };
    case 'error-handling':
      return {
        before: `func ${fn}() []byte {\n\tdata, _ := os.ReadFile("${stem}.json")\n\treturn data\n}`,
        after: `func ${fn}() ([]byte, error) {\n\tdata, err := os.ReadFile("${stem}.json")\n\tif err != nil {\n\t\treturn nil, fmt.Errorf("${fn}: %w", err)\n\t}\n\treturn data, nil\n}`,
      };
    case 'bounds-check':
      return {
        before: `func ${fn}(items []Item) int {\n\ttotal := 0\n\tfor i := 0; i <= len(items); i++ {\n\t\ttotal += items[i].Value\n\t}\n\treturn total\n}`,
        after: `func ${fn}(items []Item) int {\n\ttotal := 0\n\tfor i := 0; i < len(items); i++ {\n\t\ttotal += items[i].Value\n\t}\n\treturn total\n}`,
      };
    case 'unsafe-input':
      return {
        before: `func ${fn}(id string) {\n\tdb.Query("SELECT * FROM users WHERE id = " + id)\n}`,
        after: `func ${fn}(id string) {\n\tdb.Query("SELECT * FROM users WHERE id = ?", id)\n}`,
      };
    default: // resource-leak
      return {
        before: `func ${fn}(path string) []byte {\n\tf, _ := os.Open(path)\n\tb, _ := io.ReadAll(f)\n\treturn b\n}`,
        after: `func ${fn}(path string) ([]byte, error) {\n\tf, err := os.Open(path)\n\tif err != nil {\n\t\treturn nil, err\n\t}\n\tdefer f.Close()\n\treturn io.ReadAll(f)\n}`,
      };
  }
}

function genericSnippet(pattern, stem) {
  const fn = camelish(stem);
  switch (pattern) {
    case 'null-check':
      return {
        before: `function ${fn}(user) {\n  return user.profile.name.trim();\n}`,
        after: `function ${fn}(user) {\n  if (user == null || user.profile == null) return "";\n  return (user.profile.name || "").trim();\n}`,
      };
    case 'error-handling':
      return {
        before: `function ${fn}() {\n  data = loadData("${stem}");\n  return data;\n}`,
        after: `function ${fn}() {\n  try {\n    data = loadData("${stem}");\n    return data;\n  } catch (err) {\n    log("${fn} failed", err);\n    return null;\n  }\n}`,
      };
    case 'bounds-check':
      return {
        before: `function ${fn}(items) {\n  total = 0;\n  for (i = 0; i <= items.length; i++) {\n    total += items[i].value;\n  }\n  return total;\n}`,
        after: `function ${fn}(items) {\n  total = 0;\n  for (i = 0; i < items.length; i++) {\n    total += items[i].value;\n  }\n  return total;\n}`,
      };
    case 'unsafe-input':
      return {
        before: `query("SELECT * FROM users WHERE id = " + userId);`,
        after: `query("SELECT * FROM users WHERE id = ?", [userId]);`,
      };
    default: // resource-leak
      return {
        before: `handle = open(path);\nread(handle);`,
        after: `handle = open(path);\ntry {\n  read(handle);\n} finally {\n  close(handle);\n}`,
      };
  }
}

/* ------------------------------------------------------------------ */
/* Non-code file families: css / config(json,yaml) / docs(md)          */
/* Each entry carries its own problem/impact/explanation clause so it  */
/* doesn't have to be forced through the code-bug pattern language.    */
/* ------------------------------------------------------------------ */

const CSS_VARIANTS = [
  {
    title: 'Fix a selector specificity clash',
    problem: 'a more specific selector defined elsewhere silently overrides this rule',
    impact: 'the element renders with the wrong style for some users, depending on load order',
    explain: "Two style rules were both trying to control the same look, and the more specific one always won — even when it wasn't the one meant to apply. The fix scopes the intended rule so it wins where it's supposed to, without touching anything else.",
    before: `.button {\n  color: var(--text);\n}`,
    after: `.rw-panel .button {\n  color: var(--text);\n}`,
  },
  {
    title: 'Add a missing fallback value',
    problem: 'a modern-only CSS feature is used with no fallback for older browsers',
    impact: 'the layout silently breaks for anyone on an older browser, with no error to point at',
    explain: "The style only worked on newer browsers, and older ones just ignored it with no warning. The fix adds a simple fallback line first, so every browser gets a usable layout even if it can't use the fancy version.",
    before: `.card {\n  display: grid;\n}`,
    after: `.card {\n  display: block;\n  display: grid;\n}`,
  },
  {
    title: 'Remove a duplicated, shadowing rule',
    problem: 'the same selector is defined twice, and the second definition silently wins',
    impact: 'a future edit to the first rule quietly does nothing, wasting time chasing a "bug" that is just dead code',
    explain: "The same style was written twice, and the second copy always overruled the first — so changing the first one never seemed to do anything. The fix deletes the duplicate, so there's only one rule to edit.",
    before: `.title { font-size: 14px; }\n.title { font-size: 12px; }`,
    after: `.title { font-size: 14px; }`,
  },
  {
    title: 'Drop an unnecessary !important',
    problem: 'an !important override hides the real rule that should be edited instead',
    impact: 'the next person to fix this style has no idea why their change has no effect',
    explain: "A style was forced to win no matter what, using a special override — which then made it impossible for anyone to fix the real problem underneath. The fix removes the override so the actual rule controls the look again.",
    before: `.badge { color: red !important; }`,
    after: `.badge { color: red; }`,
  },
];

const CONFIG_VARIANTS = [
  {
    title: 'Add a missing default value',
    problem: 'a required setting has no default, so a fresh install crashes before it even starts',
    impact: 'anyone setting this project up for the first time hits a confusing crash with no fix in sight',
    explain: "A setting the program needs was left unset by default, so a brand-new setup would fail before doing anything useful. The fix gives it a safe default value, so things work out of the box.",
    before: `{\n  "timeoutMs": null\n}`,
    after: `{\n  "timeoutMs": 5000\n}`,
  },
  {
    title: 'Fix a type mismatch in config',
    problem: 'a value is written as a string where the code expects a number',
    impact: 'the setting gets silently ignored or mis-parsed, and nobody notices until it matters',
    explain: "A number was accidentally written as text, so the program either ignored it or misread it. The fix writes it as a real number, so it's used exactly as intended.",
    before: `{\n  "retries": "3"\n}`,
    after: `{\n  "retries": 3\n}`,
  },
  {
    title: 'Remove a duplicate key',
    problem: 'the same key appears twice, so only the last one silently takes effect',
    impact: 'someone edits the first copy expecting it to matter, and nothing changes',
    explain: "The same setting was listed twice, and only the second one actually counted — so editing the first copy did nothing. The fix keeps just one copy, so there's no confusion about which value is real.",
    before: `{\n  "port": 3000,\n  "port": 8080\n}`,
    after: `{\n  "port": 8080\n}`,
  },
  {
    title: 'Pin an unpinned dependency version',
    problem: 'a dependency is left unpinned, so builds can silently pick up a breaking new version',
    impact: 'the exact same code can build fine today and fail tomorrow, for no code reason at all',
    explain: "A dependency was allowed to update itself automatically, so a future update could break things without any code changing at all. The fix locks it to a known-good version, so builds stay predictable.",
    before: `{\n  "some-lib": "*"\n}`,
    after: `{\n  "some-lib": "2.4.1"\n}`,
  },
];

const DOCS_VARIANTS = [
  {
    title: 'Update a stale code example',
    problem: 'the documented example still shows an old API that no longer exists',
    impact: 'new contributors copy the broken example and get stuck before they even start',
    explain: "The instructions showed an old way of doing things that doesn't work anymore. The fix updates the example to match how the code actually works today, so people following it succeed on the first try.",
    before: `\`\`\`\nclient.oldMethod(opts)\n\`\`\``,
    after: `\`\`\`\nclient.newMethod(opts)\n\`\`\``,
  },
  {
    title: 'Add a missing setup step',
    problem: 'the setup guide skips a required step that the project silently depends on',
    impact: 'anyone following the docs from scratch gets stuck at the same spot every time',
    explain: "A step everyone needs to do was left out of the instructions, so newcomers kept getting stuck in the same place. The fix adds that step back in, in the right order.",
    before: `1. Clone the repo\n2. Run the app`,
    after: `1. Clone the repo\n2. Copy .env.example to .env\n3. Run the app`,
  },
  {
    title: 'Fix a broken link',
    problem: 'a link in the docs points at a page or file that has since moved or been renamed',
    impact: 'readers hit a dead end right when they need the extra detail most',
    explain: "A link in the docs pointed somewhere that no longer exists, so readers hit a dead end. The fix points it at the current location instead.",
    before: `See [the config guide](./old-config.md).`,
    after: `See [the config guide](./config.md).`,
  },
  {
    title: 'Clarify an ambiguous instruction',
    problem: 'a step can be read two different ways, and one of those ways is wrong',
    impact: 'some fraction of readers follow the wrong interpretation and get a broken result',
    explain: "An instruction could be understood in two different ways, and only one of them actually worked. The fix rewrites it so there's only one way to read it.",
    before: `Set the flag before starting the server.`,
    after: `Set the RW_FLAG environment variable, then run \`npm run dev\`.`,
  },
];

function severityImpactLead(severity) {
  if (severity >= 8) return 'a critical, user-facing failure';
  if (severity >= 5) return 'a real, reproducible failure';
  return 'a minor but real glitch';
}

function kindFrameLead(kind, title) {
  if (kind === 'pr') return `The open pull request "${title}" still leaves a gap: `;
  if (kind === 'risk') return `Greptile flagged this file as risky ("${title}"). The likely problem: `;
  return `The reported issue "${title}" comes down to this: `;
}

function kindExplainOpen(kind) {
  if (kind === 'pr') return "Someone already started fixing this, but the fix doesn't cover every case yet.";
  if (kind === 'risk') return 'This file was flagged as risky by automated analysis, before anything even broke.';
  return 'Something in this file was quietly broken.';
}

/* ------------------------------------------------------------------ */
/* mockFix — deterministic, offline, no network, no Math.random        */
/* ------------------------------------------------------------------ */

/**
 * Deterministic offline fallback FixReport for one hazard. Never throws —
 * a missing/malformed hazard just falls back to sane defaults. This is what
 * runs on stage whenever Greptile is unavailable or fails.
 * @param {Hazard|Object|null|undefined} hazard
 * @returns {FixReport}
 */
export function mockFix(hazard) {
  const h = hazard && typeof hazard === 'object' ? hazard : {};
  const kind = h.kind === 'pr' || h.kind === 'risk' ? h.kind : 'issue';
  const rawPath = typeof h.path === 'string' && h.path.trim() ? h.path.trim() : 'src/app.js';
  const path = rawPath.replace(/^\.?\/+/, '') || 'src/app.js';
  const title = nonEmpty(h.title, 'Unnamed issue');
  const reason = nonEmpty(h.reason, '');
  const severity = clampSeverity(h.severity);
  const id = nonEmpty(h.id, `${kind}-${path}`);

  const base = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  const stem = (base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base) || 'file';
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
  const family = familyForExt(ext);
  const hash = hashStr(`${id}::${path}::${kind}::${title}`);

  let fixTitle;
  let problem;
  let impact;
  let before;
  let after;
  let explanation;

  if (family === 'css' || family === 'config' || family === 'docs') {
    const variants = family === 'css' ? CSS_VARIANTS : family === 'config' ? CONFIG_VARIANTS : DOCS_VARIANTS;
    const v = variants[hash % variants.length];
    fixTitle = `${v.title} — ${base}`;
    problem = `${kindFrameLead(kind, title)}${v.problem}.`;
    impact = `Left unfixed, this causes ${severityImpactLead(severity)}: ${v.impact}.`;
    before = v.before;
    after = v.after;
    explanation = `${kindExplainOpen(kind)} ${v.explain}`;
  } else {
    const pattern = CODE_PATTERNS[hash % CODE_PATTERNS.length];
    const snip = family === 'js' ? jsSnippet(pattern, stem)
      : family === 'py' ? pySnippet(pattern, stem)
        : family === 'go' ? goSnippet(pattern, stem)
          : genericSnippet(pattern, stem);
    fixTitle = `${PATTERN_TITLE[pattern]} — ${base}`;
    problem = `${kindFrameLead(kind, title)}${PATTERN_PROBLEM[pattern]}${reason ? ` (Greptile's notes: "${reason}")` : ''}.`;
    impact = `Left unfixed, this causes ${severityImpactLead(severity)}: ${PATTERN_IMPACT[pattern]}.`;
    before = snip.before;
    after = snip.after;
    explanation = `${kindExplainOpen(kind)} ${PATTERN_EXPLANATION[pattern]}`;
  }

  return {
    title: fixTitle,
    problem,
    impact,
    files: [path],
    before,
    after,
    explanation,
    confidence: 'heuristic',
  };
}

/* ------------------------------------------------------------------ */
/* Greptile integration                                                */
/* ------------------------------------------------------------------ */

/** @param {RepoRef} repo */
function repoBody(repo) {
  const r = repo && typeof repo === 'object' ? repo : {};
  return {
    remote: 'github',
    repository: `${asStr(r.owner)}/${asStr(r.repo)}`,
    branch: r.branch || 'main',
  };
}

function kindLabel(kind) {
  if (kind === 'pr') return 'an open pull request';
  if (kind === 'risk') return 'a static-analysis risk finding';
  return 'a reported GitHub issue';
}

function buildPrompt(hazard) {
  const h = hazard && typeof hazard === 'object' ? hazard : {};
  return (
    'You are helping a total beginner programmer understand a real bug and its fix, as ' +
    'part of a code-review teaching game built on top of this codebase. The following is ' +
    `${kindLabel(h.kind)} in this repository:\n` +
    `Title: ${asStr(h.title) || '(untitled)'}\n` +
    `File: ${asStr(h.path) || '(unknown file)'}\n` +
    `Severity: ${Number.isFinite(Number(h.severity)) ? h.severity : '?'} / 10\n` +
    `Details: ${asStr(h.reason) || '(no further detail provided)'}\n\n` +
    'Look at the actual file(s) involved and return ONLY a JSON object, no prose, no ' +
    'markdown fence, in exactly this shape:\n' +
    '{"title": "<short fix title>", ' +
    '"problem": "<1-2 sentences: what is actually wrong, grounded in the real code>", ' +
    '"impact": "<1 sentence: why it matters / what breaks>", ' +
    '"files": ["<repo-relative file path(s) touched>"], ' +
    '"before": "<a short buggy code snippet, at most 8 lines, real syntax for this file\'s language>", ' +
    '"after": "<the fixed version of that same snippet>", ' +
    '"explanation": "<2-3 plain-English sentences a total beginner could follow, no jargon, ' +
    'explaining what went wrong and why the fix works>"}'
  );
}

/**
 * Extract the first JSON object from free text that may contain markdown
 * fences, prose, or trailing commas. Mirrors extractJsonArray in greptile.js.
 * Exported for testing.
 * @param {string} text
 * @returns {Object|null}
 */
export function extractJsonObject(text) {
  if (typeof text !== 'string' || !text) return null;
  const stripped = text.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '');
  const start = stripped.indexOf('{');
  if (start === -1) return null;

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
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const candidate = end !== -1
    ? stripped.slice(start, end + 1)
    : (stripped.lastIndexOf('}') > start ? stripped.slice(start, stripped.lastIndexOf('}') + 1) : null);
  if (!candidate) return null;

  for (const attempt of [candidate, candidate.replace(/,\s*([\]}])/g, '$1')]) {
    try {
      const parsed = JSON.parse(attempt);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* try next repair */ }
  }
  return null;
}

function clampFilesList(list, fallback) {
  if (!Array.isArray(list)) return fallback;
  const out = list.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().replace(/^\.?\/+/, ''));
  return out.length > 0 ? out : fallback;
}

/** Combine a parsed Greptile object with the offline fallback. Returns null
 *  when the parse is too thin to trust (missing the core fields). */
function mergeFix(parsed, fallback) {
  if (!parsed || typeof parsed !== 'object') return null;
  const title = nonEmpty(parsed.title, '');
  const problem = nonEmpty(parsed.problem, '');
  const before = nonEmpty(parsed.before, '');
  const after = nonEmpty(parsed.after, '');
  if (!title || !problem || !before || !after) return null;
  return {
    title,
    problem,
    impact: nonEmpty(parsed.impact, fallback.impact),
    files: clampFilesList(parsed.files, fallback.files),
    before,
    after,
    explanation: nonEmpty(parsed.explanation, fallback.explanation),
    confidence: 'greptile',
  };
}

async function runFixQuery(repo, hazard, timeoutMs) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`${BASE}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ id: `msg-${Date.now()}`, role: 'user', content: buildPrompt(hazard) }],
        repositories: [repoBody(repo)],
        sessionId: `repo-world-fix-${asStr(repo && repo.owner) || 'x'}-${asStr(repo && repo.repo) || 'y'}-${Date.now()}`,
        genius: true,
        stream: false,
      }),
      signal: controller ? controller.signal : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Ask Greptile what's wrong with one hazard and what the fix should look
 * like. Never throws; falls back to `mockFix(hazard)` on any missing key,
 * network failure, timeout, or unparseable response.
 * @param {RepoRef} repo
 * @param {Hazard} hazard
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<FixReport>}
 */
export async function fetchFix(repo, hazard, opts = {}) {
  const fallback = mockFix(hazard);
  if (!greptileAvailable()) return fallback;
  const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  try {
    const data = await runFixQuery(repo, hazard, timeoutMs);
    const text = typeof data.message === 'string' ? data.message : '';
    const parsed = extractJsonObject(text);
    const merged = mergeFix(parsed, fallback);
    if (merged) return merged;

    // Structured parse failed — synthesize a best-effort fix from sources[] + prose,
    // the same fallback tier queryRisks() uses in greptile.js.
    if (Array.isArray(data.sources) && data.sources.length > 0) {
      const seen = new Set();
      const files = [];
      for (const s of data.sources) {
        if (s && typeof s.filepath === 'string' && s.filepath) {
          const p = s.filepath.replace(/^\.?\/+/, '');
          if (!seen.has(p)) { seen.add(p); files.push(p); }
        }
      }
      const prose = text.trim();
      if (files.length > 0 || prose) {
        return {
          ...fallback,
          files: files.length > 0 ? files.slice(0, 5) : fallback.files,
          problem: prose ? firstSentences(prose, 2) : fallback.problem,
          explanation: prose ? firstSentences(prose, 3) : fallback.explanation,
          confidence: 'heuristic',
        };
      }
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* summarizeForLearner — the "get kids into coding" surface             */
/* ------------------------------------------------------------------ */

/** Replace a few common jargon terms with plain-English phrasing. Applied to
 *  whatever text summarizeForLearner ends up working with, since Greptile's
 *  freeform `explanation` can't be guaranteed jargon-free the way our own
 *  hand-written PATTERN_EXPLANATION copy can. */
const JARGON_MAP = [
  [/\bnull(?:able)?\b/gi, 'empty/missing value'],
  [/\bundefined\b/gi, 'missing value'],
  [/\bexceptions?\b/gi, 'errors'],
  [/\basynchronous(ly)?\b/gi, 'happening in the background'],
  [/\basync\b/gi, 'background'],
  [/\brace condition\b/gi, 'timing mix-up'],
  [/\bAPI\b/g, "way the program talks to another service"],
  [/\bSQL injection\b/gi, "a trick where typed text takes over a database command"],
  [/\bregex(p)?\b/gi, 'pattern matching'],
  [/\bstack trace\b/gi, 'error trail'],
  [/\bnull pointer\b/gi, 'missing value'],
];

function declutter(text) {
  let out = String(text || '');
  for (const [re, rep] of JARGON_MAP) out = out.replace(re, rep);
  return out;
}

function splitSentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

function lowerFirst(s) {
  const t = String(s || '');
  return t ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}

/**
 * A short, plain-English, jargon-light explanation of one FixReport, aimed
 * at someone brand-new to code — 2-3 sentences: what went wrong, and why
 * the fix works. Never throws; degrades gracefully for a missing/partial fix.
 * @param {FixReport|Object|null|undefined} fix
 * @returns {string}
 */
export function summarizeForLearner(fix) {
  const f = fix && typeof fix === 'object' ? fix : {};
  let source = nonEmpty(f.explanation, '');

  if (!source) {
    const problem = nonEmpty(f.problem, '');
    const impact = nonEmpty(f.impact, '');
    if (problem || impact) {
      source = `Something went wrong: ${problem || 'the code did not handle a case it needed to.'} ` +
        (impact
          ? `If left broken, ${lowerFirst(impact)}`
          : 'The fix makes sure that case is handled safely from now on.');
    } else {
      source = 'This code had a small mistake that could make it behave unexpectedly. The fix checks for ' +
        'that case directly and handles it safely, so the program keeps working the way it should.';
    }
  }

  source = declutter(source);
  let sentences = splitSentences(source);
  if (sentences.length === 0) sentences = [source].filter(Boolean);
  if (sentences.length === 0) {
    sentences = ['This code had a small mistake, and the fix takes care of it safely.'];
  }
  if (sentences.length > 3) sentences = sentences.slice(0, 3);
  if (sentences.length < 2) {
    sentences.push('Now the program checks for that case and keeps working correctly.');
  }

  let out = sentences.join(' ').trim();
  if (out.length > 480) out = out.slice(0, 477).trimEnd() + '…';
  return out;
}
