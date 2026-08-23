/**
 * Offline demo fixture — a plausible fake TypeScript/React repo so the whole
 * app can be demoed with zero network access. Shapes match types.js
 * (RepoRef, FileNode) and the RawIssue shape produced by github.js.
 */

import { langForExt } from './types.js';

/** @param {string} path @param {number} size */
function file(path, size) {
  const slash = path.lastIndexOf('/');
  const name = slash === -1 ? path : path.slice(slash + 1);
  const dir = slash === -1 ? '' : path.slice(0, slash);
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return { path, name, dir, size, ext, lang: langForExt(ext) };
}

const FILES = [
  // root
  file('package.json', 2140),
  file('tsconfig.json', 890),
  file('vite.config.ts', 1320),
  file('index.html', 760),
  // src root
  file('src/main.tsx', 980),
  file('src/App.tsx', 6400),
  file('src/router.tsx', 2900),
  file('src/styles.css', 5100),
  // src/components
  file('src/components/Dashboard.tsx', 14200),
  file('src/components/Sidebar.tsx', 5600),
  file('src/components/Header.tsx', 3100),
  file('src/components/MetricsChart.tsx', 11800),
  file('src/components/AlertBanner.tsx', 2400),
  file('src/components/UserAvatar.tsx', 1700),
  file('src/components/SettingsPanel.tsx', 8900),
  file('src/components/DataTable.tsx', 16700),
  file('src/components/Modal.tsx', 4300),
  file('src/components/Tooltip.tsx', 2100),
  // src/lib
  file('src/lib/websocket.ts', 9800),
  file('src/lib/auth.ts', 7600),
  file('src/lib/cache.ts', 5400),
  file('src/lib/format.ts', 3200),
  file('src/lib/logger.ts', 2800),
  file('src/lib/queryClient.ts', 4100),
  file('src/lib/validation.ts', 6100),
  // src/api
  file('src/api/client.ts', 8300),
  file('src/api/metrics.ts', 5900),
  file('src/api/users.ts', 4700),
  file('src/api/alerts.ts', 3600),
  file('src/api/types.ts', 7200),
  // src/hooks
  file('src/hooks/useWebSocket.ts', 6800),
  file('src/hooks/useAuth.ts', 4500),
  file('src/hooks/useMetrics.ts', 3900),
  file('src/hooks/useDebounce.ts', 1100),
  // src/state
  file('src/state/store.ts', 5200),
  file('src/state/sessionSlice.ts', 4400),
  file('src/state/metricsSlice.ts', 4800),
  // tests
  file('tests/auth.test.ts', 5300),
  file('tests/websocket.test.ts', 6200),
  file('tests/format.test.ts', 2600),
  file('tests/DataTable.test.tsx', 7100),
  // scripts / config
  file('scripts/seed.ts', 3400),
  file('.github/workflows/ci.yml', 1500),
];

/** @param {Object} o */
function issue(o) {
  return {
    number: o.number,
    title: o.title,
    body: o.body || '',
    labels: o.labels || [],
    comments: o.comments || 0,
    createdAt: o.createdAt,
    url: `https://github.com/acme/pulse-dashboard/${o.isPR ? 'pull' : 'issues'}/${o.number}`,
    isPR: !!o.isPR,
    changedFiles: o.changedFiles || [],
  };
}

const ISSUES = [
  issue({
    number: 142, title: 'Memory leak in websocket reconnect',
    body: 'After the connection drops, every reconnect registers a new message listener without removing the old one. Heap grows ~4MB/hour on the dashboard page until the tab dies.',
    labels: ['bug', 'critical'], comments: 23, createdAt: '2026-03-11T09:14:00Z',
  }),
  issue({
    number: 156, title: 'Auth token refresh race condition',
    body: 'Two parallel API calls both see an expired token and both trigger refresh; the second refresh invalidates the first, logging the user out mid-session.',
    labels: ['bug', 'critical', 'auth'], comments: 17, createdAt: '2026-04-02T15:40:00Z',
  }),
  issue({
    number: 98, title: 'DataTable renders entire dataset with no virtualization',
    body: 'With 10k+ rows the table takes 6s to mount and scrolling drops to ~8fps. We should windowize rows.',
    labels: ['performance'], comments: 12, createdAt: '2026-01-19T11:02:00Z',
  }),
  issue({
    number: 171, title: 'MetricsChart tooltip crashes on null datapoints',
    body: 'TypeError: Cannot read properties of null (reading "value") when hovering over a gap in the series.',
    labels: ['bug'], comments: 6, createdAt: '2026-05-07T18:25:00Z',
  }),
  issue({
    number: 133, title: 'Cache never evicts — unbounded Map growth',
    body: 'src/lib/cache.ts stores every response keyed by URL forever. Needs an LRU with a size cap.',
    labels: ['bug', 'performance'], comments: 9, createdAt: '2026-02-24T08:50:00Z',
  }),
  issue({
    number: 187, title: 'Add dark mode to settings panel',
    body: 'Users keep asking for a theme toggle. Tokens are mostly in styles.css already.',
    labels: ['enhancement'], comments: 4, createdAt: '2026-06-15T13:12:00Z',
  }),
  issue({
    number: 165, title: 'Sidebar collapse state lost on navigation',
    body: 'Collapsing the sidebar then clicking any route re-expands it. Store it in the session slice.',
    labels: ['bug', 'ux'], comments: 3, createdAt: '2026-04-28T10:33:00Z',
  }),
  issue({
    number: 190, title: 'Flaky test: websocket.test.ts times out on CI',
    body: 'Fails ~1 in 5 runs with a 5s timeout waiting for the mock server close event.',
    labels: ['bug', 'ci'], comments: 8, createdAt: '2026-06-30T07:45:00Z',
  }),
  issue({
    number: 201, title: 'Validation errors not localized',
    body: 'src/lib/validation.ts hardcodes English strings; we need message keys for the i18n pass.',
    labels: ['enhancement', 'i18n'], comments: 2, createdAt: '2026-07-21T16:08:00Z',
  }),
  issue({
    number: 118, title: 'Logger writes secrets to console in dev',
    body: 'The request logger dumps full headers including Authorization. Redact before the next release.',
    labels: ['bug', 'security'], comments: 14, createdAt: '2026-02-05T12:19:00Z',
  }),
];

const PRS = [
  issue({
    number: 204, isPR: true, title: 'Fix websocket reconnect listener leak',
    body: 'Tracks the active listener and removes it before re-subscribing. Adds a regression test. Fixes #142.',
    labels: ['bug', 'critical'], comments: 19, createdAt: '2026-07-30T14:20:00Z',
    changedFiles: ['src/lib/websocket.ts', 'src/hooks/useWebSocket.ts', 'tests/websocket.test.ts'],
  }),
  issue({
    number: 209, isPR: true, title: 'Serialize token refresh behind a single in-flight promise',
    body: 'All callers now await one shared refresh promise. Fixes #156.',
    labels: ['bug', 'auth'], comments: 11, createdAt: '2026-08-06T09:55:00Z',
    changedFiles: ['src/lib/auth.ts', 'src/hooks/useAuth.ts', 'src/api/client.ts', 'tests/auth.test.ts'],
  }),
  issue({
    number: 197, isPR: true, title: 'Virtualize DataTable rows',
    body: 'Windowed rendering with a 20-row overscan; mount time down from 6s to 180ms on the 10k fixture.',
    labels: ['performance'], comments: 7, createdAt: '2026-07-12T11:30:00Z',
    changedFiles: ['src/components/DataTable.tsx', 'tests/DataTable.test.tsx'],
  }),
  issue({
    number: 211, isPR: true, title: 'Add LRU eviction to response cache',
    body: 'Caps the cache at 500 entries with least-recently-used eviction. Fixes #133.',
    labels: ['performance'], comments: 4, createdAt: '2026-08-12T17:02:00Z',
    changedFiles: ['src/lib/cache.ts', 'src/lib/queryClient.ts'],
  }),
  issue({
    number: 214, isPR: true, title: 'Redact auth headers in dev logger',
    body: 'Masks Authorization and cookie headers before logging. Fixes #118.',
    labels: ['security'], comments: 2, createdAt: '2026-08-18T08:41:00Z',
    changedFiles: ['src/lib/logger.ts'],
  }),
];

export const MOCK_WORLD_INPUT = {
  repo: { owner: 'acme', repo: 'pulse-dashboard', branch: 'main' },
  files: FILES,
  issues: ISSUES,
  prs: PRS,
  meta: {
    description: 'Real-time operations dashboard: live metrics, alerting, and team analytics.',
    language: 'TypeScript',
    stars: 2847,
    topics: ['react', 'typescript', 'websockets', 'dashboard', 'observability'],
    readme: [
      '# Pulse Dashboard',
      '',
      'Real-time operations dashboard for engineering teams. Streams service metrics',
      'over websockets, renders live charts, and raises alerts when thresholds trip.',
      '',
      '## Stack',
      '- React 19 + TypeScript + Vite',
      '- Websocket streaming layer with reconnect/backoff (src/lib/websocket.ts)',
      '- Token-based auth with silent refresh (src/lib/auth.ts)',
      '',
      '## Getting started',
      '```',
      'npm install && npm run dev',
      '```',
    ].join('\n'),
  },
};

/**
 * True when the app should run fully offline on MOCK_WORLD_INPUT:
 * the user typed "demo", "mock", or left the input empty.
 * @param {string} input
 * @returns {boolean}
 */
export function isMockRepo(input) {
  const s = String(input || '').trim().toLowerCase();
  return s === '' || s === 'demo' || s === 'mock';
}
