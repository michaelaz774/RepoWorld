import { describe, it, expect } from 'vitest';
import { mockFix, summarizeForLearner, extractJsonObject, fetchFix } from './fixes.js';

const HAZARD_ISSUE = {
  id: 'issue-42',
  path: 'src/auth/login.js',
  kind: 'issue',
  severity: 8,
  title: 'Login crashes when profile is missing',
  reason: 'Null profile causes a TypeError on the happy path.',
  url: 'https://github.com/acme/repo/issues/42',
  number: 42,
  ageDays: 12,
  comments: 4,
};

const HAZARD_PR = {
  id: 'pr-7',
  path: 'src/server/handler.py',
  kind: 'pr',
  severity: 5,
  title: 'Retry logic for flaky requests',
  reason: 'Only retries once, still drops the error silently.',
  url: 'https://github.com/acme/repo/pull/7',
  number: 7,
  ageDays: 3,
  comments: 1,
};

const HAZARD_RISK = {
  id: 'risk-src/db/query.go',
  path: 'src/db/query.go',
  kind: 'risk',
  severity: 9,
  title: 'Risky: query.go',
  reason: 'String-concatenated SQL with request-derived values.',
  url: null,
  number: null,
  ageDays: 0,
  comments: 0,
};

describe('mockFix', () => {
  it('is deterministic — same hazard twice gives deep-equal output', () => {
    expect(mockFix(HAZARD_ISSUE)).toEqual(mockFix(HAZARD_ISSUE));
    expect(mockFix(HAZARD_ISSUE)).toEqual(mockFix({ ...HAZARD_ISSUE }));
    expect(mockFix(HAZARD_PR)).toEqual(mockFix({ ...HAZARD_PR }));
    expect(mockFix(HAZARD_RISK)).toEqual(mockFix({ ...HAZARD_RISK }));
  });

  it('produces a full, non-empty FixReport shape', () => {
    for (const h of [HAZARD_ISSUE, HAZARD_PR, HAZARD_RISK]) {
      const fix = mockFix(h);
      expect(typeof fix.title).toBe('string');
      expect(fix.title.length).toBeGreaterThan(0);
      expect(typeof fix.problem).toBe('string');
      expect(fix.problem.length).toBeGreaterThan(10);
      expect(typeof fix.impact).toBe('string');
      expect(fix.impact.length).toBeGreaterThan(10);
      expect(Array.isArray(fix.files)).toBe(true);
      expect(fix.files.length).toBeGreaterThan(0);
      expect(typeof fix.before).toBe('string');
      expect(fix.before.length).toBeGreaterThan(0);
      expect(typeof fix.after).toBe('string');
      expect(fix.after.length).toBeGreaterThan(0);
      expect(fix.before).not.toBe(fix.after);
      expect(typeof fix.explanation).toBe('string');
      expect(fix.explanation.length).toBeGreaterThan(10);
      expect(fix.confidence).toBe('heuristic');
    }
  });

  it('covers every hazard kind (issue/pr/risk) with non-empty problem/before/after', () => {
    for (const kind of ['issue', 'pr', 'risk']) {
      const fix = mockFix({ ...HAZARD_ISSUE, kind, id: `${kind}-x`, path: 'src/thing.js' });
      expect(fix.problem.trim().length).toBeGreaterThan(0);
      expect(fix.before.trim().length).toBeGreaterThan(0);
      expect(fix.after.trim().length).toBeGreaterThan(0);
    }
  });

  it('covers several file extensions with non-empty problem/before/after', () => {
    const exts = ['js', 'jsx', 'ts', 'py', 'go', 'rb', 'java', 'css', 'json', 'yml', 'md', 'txt', ''];
    for (const ext of exts) {
      const path = ext ? `src/module/thing.${ext}` : 'src/module/Makefile';
      const fix = mockFix({ ...HAZARD_ISSUE, id: `issue-${path}`, path });
      expect(fix.problem.trim().length, `problem for .${ext}`).toBeGreaterThan(0);
      expect(fix.before.trim().length, `before for .${ext}`).toBeGreaterThan(0);
      expect(fix.after.trim().length, `after for .${ext}`).toBeGreaterThan(0);
      expect(fix.files).toEqual([path.replace(/^\.?\/+/, '')]);
    }
  });

  it('produces different snippets for different patterns/hazards (not one template repeated)', () => {
    const fixes = new Set();
    for (let i = 0; i < 12; i++) {
      const fix = mockFix({ ...HAZARD_ISSUE, id: `issue-${i}`, path: `src/mod${i}.js` });
      fixes.add(fix.before);
    }
    // With 5 code patterns in the rotation, 12 distinct hazards should not collapse to 1.
    expect(fixes.size).toBeGreaterThan(1);
  });

  it('handles a malformed/empty hazard without throwing', () => {
    expect(() => mockFix(null)).not.toThrow();
    expect(() => mockFix(undefined)).not.toThrow();
    expect(() => mockFix({})).not.toThrow();
    expect(() => mockFix('nope')).not.toThrow();
    expect(() => mockFix(42)).not.toThrow();
    expect(() => mockFix({ kind: 'not-a-real-kind', path: 123, severity: 'high', title: null })).not.toThrow();

    const fix = mockFix({});
    expect(fix.title.length).toBeGreaterThan(0);
    expect(fix.before.length).toBeGreaterThan(0);
    expect(fix.after.length).toBeGreaterThan(0);
    expect(fix.files.length).toBeGreaterThan(0);

    // Two independently-malformed hazards that normalize the same way still agree.
    expect(mockFix({})).toEqual(mockFix(undefined));
  });

  it('clamps out-of-range severity into 1..10 without throwing', () => {
    expect(() => mockFix({ ...HAZARD_ISSUE, severity: -50 })).not.toThrow();
    expect(() => mockFix({ ...HAZARD_ISSUE, severity: 9999 })).not.toThrow();
    expect(() => mockFix({ ...HAZARD_ISSUE, severity: NaN })).not.toThrow();
  });
});

describe('summarizeForLearner', () => {
  it('returns a non-empty, short (2-3 sentence-ish) explanation for a full fix', () => {
    const fix = mockFix(HAZARD_ISSUE);
    const summary = summarizeForLearner(fix);
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(20);
    expect(summary.length).toBeLessThan(600);
    const sentenceCount = summary.split(/(?<=[.!?])\s+/).filter(Boolean).length;
    expect(sentenceCount).toBeGreaterThanOrEqual(1);
    expect(sentenceCount).toBeLessThanOrEqual(3);
  });

  it('never throws and always returns non-empty text for missing/malformed fields', () => {
    expect(() => summarizeForLearner(null)).not.toThrow();
    expect(() => summarizeForLearner(undefined)).not.toThrow();
    expect(() => summarizeForLearner({})).not.toThrow();
    expect(() => summarizeForLearner('nope')).not.toThrow();
    expect(() => summarizeForLearner({ explanation: '' })).not.toThrow();
    expect(() => summarizeForLearner({ problem: '', impact: '' })).not.toThrow();

    for (const bad of [null, undefined, {}, 'nope', { explanation: '' }]) {
      const summary = summarizeForLearner(bad);
      expect(typeof summary).toBe('string');
      expect(summary.length).toBeGreaterThan(10);
    }
  });

  it('falls back to problem/impact when explanation is missing', () => {
    const summary = summarizeForLearner({
      problem: 'The button click handler never checks if the button is disabled.',
      impact: 'Users can double-submit a form and create duplicate orders.',
    });
    expect(summary.toLowerCase()).toContain('button');
  });

  it('simplifies a few common jargon terms', () => {
    const summary = summarizeForLearner({
      explanation: 'The function returned null and the caller crashed with an exception during an asynchronous call.',
    });
    expect(summary.toLowerCase()).not.toContain('exception');
    expect(summary).not.toMatch(/\bnull\b/);
  });

  it('is deterministic for the same input', () => {
    const fix = mockFix(HAZARD_PR);
    expect(summarizeForLearner(fix)).toBe(summarizeForLearner(fix));
  });
});

describe('extractJsonObject', () => {
  it('parses a clean JSON object', () => {
    const out = extractJsonObject('{"title":"Fix it","problem":"bad","before":"a","after":"b"}');
    expect(out).toEqual({ title: 'Fix it', problem: 'bad', before: 'a', after: 'b' });
  });

  it('parses a ```json fenced object', () => {
    const text = 'Here you go:\n```json\n{"title":"x","problem":"y"}\n```\nHope that helps!';
    expect(extractJsonObject(text)).toEqual({ title: 'x', problem: 'y' });
  });

  it('parses a fenced object with no language tag', () => {
    const text = '```\n{"a":1,"b":2}\n```';
    expect(extractJsonObject(text)).toEqual({ a: 1, b: 2 });
  });

  it('parses an object surrounded by prose before and after', () => {
    const text = 'Sure, here is the fix: {"title":"z","files":["a.js"]} let me know if you need more.';
    expect(extractJsonObject(text)).toEqual({ title: 'z', files: ['a.js'] });
  });

  it('handles nested arrays/objects and brackets/braces inside strings', () => {
    const text = 'ok {"title":"a{1}.js","reason":"see } and { and [ here","meta":{"tags":["x","y"]}} done';
    const out = extractJsonObject(text);
    expect(out.title).toBe('a{1}.js');
    expect(out.reason).toBe('see } and { and [ here');
    expect(out.meta).toEqual({ tags: ['x', 'y'] });
  });

  it('handles escaped quotes inside strings', () => {
    const text = '{"reason":"the \\"main\\" loop"}';
    expect(extractJsonObject(text)).toEqual({ reason: 'the "main" loop' });
  });

  it('recovers from trailing commas', () => {
    expect(extractJsonObject('{"a":1,"b":2,}')).toEqual({ a: 1, b: 2 });
    expect(extractJsonObject('{"a":[1,2,],}')).toEqual({ a: [1, 2] });
  });

  it('returns null on malformed input', () => {
    expect(extractJsonObject('no braces at all')).toBeNull();
    expect(extractJsonObject('{"a": unquoted}')).toBeNull();
    expect(extractJsonObject('{{{')).toBeNull();
  });

  it('returns null on empty and non-string input', () => {
    expect(extractJsonObject('')).toBeNull();
    expect(extractJsonObject(null)).toBeNull();
    expect(extractJsonObject(undefined)).toBeNull();
    expect(extractJsonObject(42)).toBeNull();
  });

  it('does not return a bare JSON array as an object', () => {
    expect(extractJsonObject('[1,2,3]')).toBeNull();
  });
});

describe('fetchFix', () => {
  it('resolves to the mock and never throws when no Greptile key is configured', async () => {
    // vitest never defines __HAS_GREPTILE__, so greptileAvailable() is false here,
    // exactly like greptile.test.js relies on for greptileAvailable().
    await expect(fetchFix({ owner: 'acme', repo: 'widgets', branch: 'main' }, HAZARD_ISSUE)).resolves.toEqual(
      mockFix(HAZARD_ISSUE)
    );
  });

  it('never throws for a malformed hazard or repo', async () => {
    await expect(fetchFix(null, null)).resolves.toBeTruthy();
    await expect(fetchFix(undefined, undefined)).resolves.toBeTruthy();
    await expect(fetchFix({}, {})).resolves.toBeTruthy();
    const result = await fetchFix(null, null);
    expect(result.confidence).toBe('heuristic');
  });
});
