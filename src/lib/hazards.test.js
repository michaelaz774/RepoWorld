import { describe, it, expect } from 'vitest';
import {
  matchIssueToPaths,
  severityForIssue,
  severityForRisk,
  buildHazards,
  hazardStats,
} from './hazards.js';

const NOW = Date.parse('2026-08-23T00:00:00Z');

function daysAgo(n) {
  return new Date(NOW - n * 86400000).toISOString();
}

function building(id, extra = {}) {
  const name = id.split('/').pop();
  return {
    id,
    path: id,
    name,
    dir: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '',
    size: 100,
    ext: name.includes('.') ? name.split('.').pop() : '',
    lang: 'JavaScript',
    x: 0, z: 0, w: 2, d: 2, height: 5,
    color: '#f1e05a',
    district: id.split('/')[0] || '/',
    ...extra,
  };
}

function issue(number, extra = {}) {
  return {
    number,
    title: `Issue ${number}`,
    body: '',
    labels: [],
    comments: 0,
    createdAt: daysAgo(1),
    url: `https://github.com/o/r/issues/${number}`,
    isPR: false,
    changedFiles: [],
    ...extra,
  };
}

const CITY = [
  building('src/auth/login.js'),
  building('src/auth/session.js'),
  building('src/net/websocket.ts'),
  building('src/parser/tokenizer.py'),
  building('lib/auth.py'),
  building('README.md'),
];

describe('matchIssueToPaths', () => {
  it('ranks an exact path mention above filename and directory matches', () => {
    const i = issue(1, {
      title: 'websocket auth is broken',
      body: 'Crash in `src/net/websocket.ts` when auth token expires; tokenizer.py untouched',
    });
    const ranked = matchIssueToPaths(i, CITY);
    expect(ranked[0]).toBe('src/net/websocket.ts');
    // filename mention still ranks, and before pure directory-word matches
    expect(ranked).toContain('src/parser/tokenizer.py');
    expect(ranked.indexOf('src/parser/tokenizer.py'))
      .toBeLessThan(ranked.indexOf('src/auth/login.js'));
  });

  it('gives PR changedFiles top priority over path mentions in text', () => {
    const pr = issue(2, {
      isPR: true,
      changedFiles: ['src/auth/login.js'],
      body: 'Related to `src/net/websocket.ts` but this PR only touches login',
    });
    const ranked = matchIssueToPaths(pr, CITY);
    expect(ranked[0]).toBe('src/auth/login.js');
    expect(ranked).toContain('src/net/websocket.ts');
  });

  it('suffix-matches partial path mentions to full building ids', () => {
    const i = issue(3, { body: 'See net/websocket.ts for the bad frame handling' });
    expect(matchIssueToPaths(i, CITY)[0]).toBe('src/net/websocket.ts');
  });

  it('matches a bare filename, ranking every candidate when ambiguous', () => {
    // both src/auth/login.js and lib/auth.py exist; "auth.py" is unambiguous
    const i = issue(4, { body: 'auth.py raises on empty password' });
    expect(matchIssueToPaths(i, CITY)[0]).toBe('lib/auth.py');
    // 'session.js' unique
    const j = issue(5, { title: 'session.js leaks timers' });
    expect(matchIssueToPaths(j, CITY)[0]).toBe('src/auth/session.js');
  });

  it('falls back to directory/module words', () => {
    const i = issue(6, { title: 'parser hangs on unicode' });
    const ranked = matchIssueToPaths(i, CITY);
    expect(ranked).toContain('src/parser/tokenizer.py');
  });

  it('directory words never beat a filename mention', () => {
    const i = issue(7, { body: 'the parser is fine but tokenizer.py loops forever' });
    expect(matchIssueToPaths(i, CITY)[0]).toBe('src/parser/tokenizer.py');
  });

  it('is robust to junk and returns [] when nothing matches', () => {
    expect(matchIssueToPaths(issue(8, { title: '☠️ !!!', body: 'zzzz qqqq' }), CITY)).toEqual([]);
    expect(matchIssueToPaths(null, CITY)).toEqual([]);
    expect(matchIssueToPaths(issue(9), [])).toEqual([]);
    expect(matchIssueToPaths({ title: null, body: undefined, changedFiles: 'nope' }, CITY)).toEqual([]);
  });
});

describe('severityForIssue', () => {
  it('orders critical+old+contested far above docs+new+quiet', () => {
    const hot = issue(1, { labels: ['critical'], comments: 20, createdAt: daysAgo(200) });
    const cold = issue(2, { labels: ['docs'], comments: 0, createdAt: daysAgo(0) });
    const sHot = severityForIssue(hot, NOW);
    const sCold = severityForIssue(cold, NOW);
    expect(sHot).toBe(10);
    expect(sCold).toBe(2);
    expect(sHot).toBeGreaterThan(sCold);
  });

  it('ranks bug above enhancement, and heat/age add on top', () => {
    const bug = issue(3, { labels: ['bug'] });
    const enh = issue(4, { labels: ['enhancement'] });
    expect(severityForIssue(bug, NOW)).toBeGreaterThan(severityForIssue(enh, NOW));
    const contestedBug = issue(5, { labels: ['bug'], comments: 6, createdAt: daysAgo(40) });
    expect(severityForIssue(contestedBug, NOW)).toBe(8); // 6 + 1 + 1
  });

  it('clamps to 1..10 and survives garbage', () => {
    expect(severityForIssue(null)).toBe(1);
    const junk = issue(6, { labels: null, comments: NaN, createdAt: 'not a date' });
    const s = severityForIssue(junk, NOW);
    expect(s).toBeGreaterThanOrEqual(1);
    expect(s).toBeLessThanOrEqual(10);
  });
});

describe('severityForRisk', () => {
  it('passes through and clamps risk_score', () => {
    expect(severityForRisk({ file: 'a.js', risk_score: 7, reason: 'x' })).toBe(7);
    expect(severityForRisk({ file: 'a.js', risk_score: 99, reason: 'x' })).toBe(10);
    expect(severityForRisk({ file: 'a.js', risk_score: -3, reason: 'x' })).toBe(1);
    expect(severityForRisk({ file: 'a.js', risk_score: 'nope', reason: 'x' })).toBe(1);
    expect(severityForRisk(null)).toBe(1);
  });
});

describe('buildHazards', () => {
  it('places matched issues on their best building', () => {
    const hazards = buildHazards({
      issues: [issue(1, { body: 'bug in `src/net/websocket.ts`' })],
      buildings: CITY,
      now: NOW,
    });
    expect(hazards).toHaveLength(1);
    expect(hazards[0]).toMatchObject({
      id: 'issue-1',
      path: 'src/net/websocket.ts',
      kind: 'issue',
      number: 1,
    });
    expect(hazards[0].url).toContain('github.com');
  });

  it('places unmatched issues on the largest buildings and drops nothing silently', () => {
    const city = [
      building('big/huge.js', { w: 6, d: 6, height: 30 }),
      building('mid/mid.js', { w: 3, d: 3, height: 10 }),
      building('tiny/small.js', { w: 2, d: 2, height: 1 }),
    ];
    const issues = [1, 2, 3].map((n) => issue(n, { title: 'no path here at all zqx' }));
    const hazards = buildHazards({ issues, buildings: city, now: NOW });
    expect(hazards).toHaveLength(3);
    for (const h of hazards) {
      expect(h.path).not.toBeNull();
      expect(h.reason).toMatch(/whole repo/i);
    }
    // deterministic round-robin starting with the largest building
    const paths = hazards.map((h) => h.path);
    expect(paths).toContain('big/huge.js');
  });

  it('places Greptile risks by exact then suffix match, skipping unknown files', () => {
    const hazards = buildHazards({
      risks: [
        { file: 'src/auth/login.js', risk_score: 9, reason: 'SQL injection in login handler.' },
        { file: 'net/websocket.ts', risk_score: 5, reason: 'Unbounded buffer growth.' },
        { file: 'ghost/nowhere.js', risk_score: 10, reason: 'should be skipped' },
      ],
      buildings: CITY,
      now: NOW,
    });
    expect(hazards).toHaveLength(2);
    const login = hazards.find((h) => h.id === 'risk-src/auth/login.js');
    expect(login).toMatchObject({
      path: 'src/auth/login.js',
      kind: 'risk',
      severity: 9,
      reason: 'SQL injection in login handler.',
      ageDays: 0,
      comments: 0,
      number: null,
      url: null,
    });
    const ws = hazards.find((h) => h.kind === 'risk' && h.path === 'src/net/websocket.ts');
    expect(ws).toBeTruthy();
    expect(hazards.some((h) => h.reason === 'should be skipped')).toBe(false);
  });

  it('marks PRs with kind "pr" and pr- ids', () => {
    const hazards = buildHazards({
      prs: [issue(42, { isPR: true, changedFiles: ['src/auth/session.js'] })],
      buildings: CITY,
      now: NOW,
    });
    expect(hazards[0]).toMatchObject({ id: 'pr-42', kind: 'pr', path: 'src/auth/session.js' });
  });

  it('caps hazards per building at 3, keeping the highest severity', () => {
    const issues = [
      issue(1, { labels: ['critical'], body: 'in `src/auth/login.js`', createdAt: daysAgo(200), comments: 20 }), // 10
      issue(2, { labels: ['bug'], body: 'in `src/auth/login.js`' }), // 6
      issue(3, { labels: [], body: 'in `src/auth/login.js`' }), // 4
      issue(4, { labels: ['docs'], body: 'in `src/auth/login.js`' }), // 2
      issue(5, { labels: ['docs'], body: 'in `src/auth/login.js`' }), // 2
    ];
    const hazards = buildHazards({ issues, buildings: CITY, now: NOW });
    const onLogin = hazards.filter((h) => h.path === 'src/auth/login.js');
    expect(onLogin).toHaveLength(3);
    const sevs = onLogin.map((h) => h.severity).sort((a, b) => b - a);
    expect(sevs[0]).toBe(10);
    expect(sevs[1]).toBe(6);
    expect(sevs[2]).toBe(4); // the two docs issues (severity 2) were the ones dropped
  });

  it('caps total hazards at 60, keeping the highest severity', () => {
    const city = [];
    const issues = [];
    for (let n = 1; n <= 70; n++) {
      const id = `mod${String(n).padStart(2, '0')}/file${n}.js`;
      city.push(building(id));
      issues.push(issue(n, {
        body: `problem in \`${id}\``,
        labels: n <= 60 ? ['critical'] : ['docs'], // last 10 are lowest severity
      }));
    }
    const hazards = buildHazards({ issues, buildings: city, now: NOW });
    expect(hazards).toHaveLength(60);
    // all kept hazards are the critical ones; every docs issue (61..70) was cut
    expect(hazards.every((h) => h.severity >= 8)).toBe(true);
    expect(hazards.some((h) => h.number > 60)).toBe(false);
  });

  it('is deterministic: same input twice gives deep-equal output', () => {
    const input = {
      issues: [
        issue(1, { labels: ['bug'], body: 'in `src/auth/login.js`', comments: 3 }),
        issue(2, { title: 'nothing matches zqx' }),
      ],
      prs: [issue(3, { isPR: true, changedFiles: ['src/net/websocket.ts'] })],
      risks: [{ file: 'lib/auth.py', risk_score: 8, reason: 'Eval on user input.' }],
      buildings: CITY,
      now: NOW,
    };
    expect(buildHazards(input)).toEqual(buildHazards(input));
  });

  it('returns [] for empty or missing inputs', () => {
    expect(buildHazards({})).toEqual([]);
    expect(buildHazards({ issues: [], prs: [], risks: [], buildings: [] })).toEqual([]);
    expect(buildHazards()).toEqual([]);
    // issues but no buildings: nothing to attach to, no null-path hazards leak out
    const noCity = buildHazards({ issues: [issue(1)], buildings: [], now: NOW });
    expect(noCity).toEqual([]);
  });

  it('truncates long titles to ~60 chars and computes ageDays', () => {
    const long = 'x'.repeat(200);
    const hazards = buildHazards({
      issues: [issue(1, { title: long, body: 'in `src/auth/login.js`', createdAt: daysAgo(47), comments: 12 })],
      buildings: CITY,
      now: NOW,
    });
    expect(hazards[0].title.length).toBeLessThanOrEqual(60);
    expect(hazards[0].ageDays).toBe(47);
    expect(hazards[0].reason).toContain('open 47 days');
    expect(hazards[0].reason).toContain('12 comments');
  });
});

describe('hazardStats', () => {
  it('aggregates totals, kinds, max severity, hottest path', () => {
    const hazards = buildHazards({
      issues: [
        issue(1, { labels: ['critical'], body: 'in `src/auth/login.js`', createdAt: daysAgo(200), comments: 20 }),
        issue(2, { labels: ['bug'], body: 'in `src/auth/login.js`' }),
      ],
      prs: [issue(3, { isPR: true, changedFiles: ['src/net/websocket.ts'] })],
      risks: [{ file: 'src/parser/tokenizer.py', risk_score: 5, reason: 'r' }],
      buildings: CITY,
      now: NOW,
    });
    const stats = hazardStats(hazards);
    expect(stats.total).toBe(4);
    expect(stats.byKind).toEqual({ issue: 2, pr: 1, risk: 1 });
    expect(stats.maxSeverity).toBe(10);
    expect(stats.hottestPath).toBe('src/auth/login.js');
  });

  it('handles empty/junk input', () => {
    expect(hazardStats([])).toEqual({
      total: 0,
      byKind: { issue: 0, pr: 0, risk: 0 },
      maxSeverity: 0,
      hottestPath: null,
    });
    expect(hazardStats(null).total).toBe(0);
  });
});
