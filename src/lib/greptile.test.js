import { describe, it, expect } from 'vitest';
import { extractJsonArray, mockRisks, greptileAvailable } from './greptile.js';

describe('extractJsonArray', () => {
  it('parses clean JSON arrays', () => {
    const out = extractJsonArray('[{"file":"src/a.js","risk_score":7,"reason":"bad"}]');
    expect(out).toEqual([{ file: 'src/a.js', risk_score: 7, reason: 'bad' }]);
  });

  it('parses ```json fenced arrays', () => {
    const text = 'Here you go:\n```json\n[{"file":"a.js","risk_score":5,"reason":"x"}]\n```\nHope that helps!';
    expect(extractJsonArray(text)).toEqual([{ file: 'a.js', risk_score: 5, reason: 'x' }]);
  });

  it('parses fenced arrays with no language tag', () => {
    const text = '```\n[1, 2, 3]\n```';
    expect(extractJsonArray(text)).toEqual([1, 2, 3]);
  });

  it('parses arrays surrounded by prose before and after', () => {
    const text = 'Based on my analysis, the riskiest files are: [{"file":"b.py","risk_score":9,"reason":"yikes"}] Let me know if you want more detail.';
    expect(extractJsonArray(text)).toEqual([{ file: 'b.py', risk_score: 9, reason: 'yikes' }]);
  });

  it('handles nested objects and brackets/braces inside strings', () => {
    const text = 'ok [{"file":"a[1].js","risk_score":4,"reason":"see ] and } and { here","meta":{"tags":["x","y"]}}] done';
    const out = extractJsonArray(text);
    expect(out).toHaveLength(1);
    expect(out[0].file).toBe('a[1].js');
    expect(out[0].reason).toBe('see ] and } and { here');
    expect(out[0].meta).toEqual({ tags: ['x', 'y'] });
  });

  it('handles escaped quotes inside strings', () => {
    const text = '[{"file":"a.js","reason":"the \\"main\\" loop"}]';
    expect(extractJsonArray(text)).toEqual([{ file: 'a.js', reason: 'the "main" loop' }]);
  });

  it('recovers from trailing commas', () => {
    const text = '[{"file":"a.js","risk_score":5,"reason":"x"},]';
    expect(extractJsonArray(text)).toEqual([{ file: 'a.js', risk_score: 5, reason: 'x' }]);
  });

  it('recovers from trailing commas inside objects', () => {
    const text = '[{"file":"a.js","risk_score":5,}]';
    expect(extractJsonArray(text)).toEqual([{ file: 'a.js', risk_score: 5 }]);
  });

  it('returns null on malformed input', () => {
    expect(extractJsonArray('no brackets at all')).toBeNull();
    expect(extractJsonArray('[{"file": unquoted}]')).toBeNull();
    expect(extractJsonArray('[[[')).toBeNull();
  });

  it('returns null on empty and non-string input', () => {
    expect(extractJsonArray('')).toBeNull();
    expect(extractJsonArray(null)).toBeNull();
    expect(extractJsonArray(undefined)).toBeNull();
    expect(extractJsonArray(42)).toBeNull();
  });

  it('does not return non-array JSON', () => {
    // First '[' lives inside the object; matcher should not produce an array from it.
    expect(extractJsonArray('{"files": 1}')).toBeNull();
  });
});

describe('mockRisks', () => {
  const files = [
    { path: 'src/auth/login.js', size: 22000 },
    { path: 'src/payments/charge.ts', size: 8000 },
    { path: 'src/utils/helpers.js', size: 3000 },
    { path: 'README.md', size: 1200 },
    { path: 'src/db/migrations/001_init.sql', size: 900 },
    { path: 'src/components/Button.jsx', size: 1500 },
    { path: 'src/lib/parser.js', size: 16000 },
    { path: 'src/lib/parser.test.js', size: 9000 },
    { path: 'package-lock.json', size: 500000 },
    { path: 'src/server/websocket/hub.go', size: 12000 },
    { path: 'config/settings.yml', size: 400 },
    { path: 'src/a/b/c/d/e/deep.js', size: 100 },
  ];

  it('is deterministic — same input twice gives deep-equal output', () => {
    expect(mockRisks(files)).toEqual(mockRisks(files));
    expect(mockRisks([...files], 5)).toEqual(mockRisks([...files], 5));
  });

  it('clamps every score to 1-10 integers', () => {
    const loaded = [
      // Piles up every signal: should clamp at 10, not overflow.
      { path: 'src/legacy/auth/payments/session/websocket/parser-migration-worker.js', size: 999999 },
      // Test fixture data file: floor at 1, never 0 or negative.
      { path: 'a.test.md', size: 0 },
    ];
    for (const r of mockRisks(loaded, 10)) {
      expect(Number.isInteger(r.risk_score)).toBe(true);
      expect(r.risk_score).toBeGreaterThanOrEqual(1);
      expect(r.risk_score).toBeLessThanOrEqual(10);
    }
    for (const r of mockRisks(files)) {
      expect(r.risk_score).toBeGreaterThanOrEqual(1);
      expect(r.risk_score).toBeLessThanOrEqual(10);
    }
  });

  it('respects the limit', () => {
    expect(mockRisks(files, 3)).toHaveLength(3);
    expect(mockRisks(files, 1)).toHaveLength(1);
    expect(mockRisks(files).length).toBeLessThanOrEqual(10);
    expect(mockRisks(files, 100)).toHaveLength(files.length);
  });

  it('returns [] for empty or invalid input', () => {
    expect(mockRisks([])).toEqual([]);
    expect(mockRisks(null)).toEqual([]);
    expect(mockRisks(undefined)).toEqual([]);
    expect(mockRisks('nope')).toEqual([]);
  });

  it('ranks risky-looking paths above docs and tests', () => {
    const out = mockRisks(files, files.length);
    const rank = (p) => out.findIndex((r) => r.file === p);
    expect(rank('src/auth/login.js')).toBeLessThan(rank('README.md'));
    expect(rank('src/payments/charge.ts')).toBeLessThan(rank('src/components/Button.jsx'));
    expect(rank('src/lib/parser.js')).toBeLessThan(rank('src/lib/parser.test.js'));
  });

  it('produces the required shape with readable reasons', () => {
    for (const r of mockRisks(files)) {
      expect(typeof r.file).toBe('string');
      expect(typeof r.risk_score).toBe('number');
      expect(typeof r.reason).toBe('string');
      expect(r.reason.length).toBeGreaterThan(20);
      expect(Object.keys(r).sort()).toEqual(['file', 'reason', 'risk_score']);
    }
  });

  it('accepts plain string paths too', () => {
    const out = mockRisks(['src/auth/session.js', 'notes.md']);
    expect(out).toHaveLength(2);
    expect(out[0].file).toBe('src/auth/session.js');
  });
});

describe('greptileAvailable', () => {
  it('does not throw when the build-time global is undefined, and returns false', () => {
    // Vitest does not define __HAS_GREPTILE__ (that comes from vite `define`),
    // so this exercises the defensive typeof path.
    expect(() => greptileAvailable()).not.toThrow();
    expect(greptileAvailable()).toBe(false);
  });
});
