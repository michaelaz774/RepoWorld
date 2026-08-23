import { describe, it, expect, vi, afterEach } from 'vitest';
import { skyboxAvailable, buildPrompt, pickStyleId, generateSkybox } from './skybox.js';

describe('buildPrompt', () => {
  const meta = {
    name: 'repo-world',
    description: 'a 3d repo explorer',
    language: 'Rust',
    topics: ['threejs', 'games'],
    summary: 'A repo explorer.',
    fileCount: 120,
    hazardCount: 0,
  };

  it('is deterministic for the same input', () => {
    expect(buildPrompt(meta)).toBe(buildPrompt({ ...meta }));
  });

  it('includes a language-derived visual cue', () => {
    expect(buildPrompt(meta)).toMatch(/rusted industrial orange/i);
    expect(buildPrompt({ ...meta, language: 'TypeScript' })).toMatch(/azure glass/i);
    expect(buildPrompt({ ...meta, language: 'Python' })).toMatch(/serene blue/i);
  });

  it('falls back to a generic cue for unknown languages', () => {
    expect(buildPrompt({ ...meta, language: 'Brainfuck' })).toMatch(/circuit-lit skyline/i);
  });

  it('changes tone with hazardCount', () => {
    const calm = buildPrompt({ ...meta, hazardCount: 0 });
    const mid = buildPrompt({ ...meta, hazardCount: 4 });
    const stormy = buildPrompt({ ...meta, hazardCount: 20 });
    expect(calm).toMatch(/clear calm dawn/i);
    expect(mid).toMatch(/hazy amber dusk/i);
    expect(stormy).toMatch(/smoky storm/i);
    expect(calm).not.toBe(stormy);
  });

  it('always includes the required panorama suffix', () => {
    const p = buildPrompt(meta);
    expect(p).toContain('360 equirectangular panorama');
    expect(p).toContain('no text, no watermark');
  });

  it('stays under the ~350 char cap even with long fields', () => {
    const long = 'x'.repeat(500);
    const p = buildPrompt({ name: long, language: 'Rust', topics: [long], hazardCount: 9 });
    expect(p.length).toBeLessThan(350);
  });

  it('handles empty/missing meta without throwing', () => {
    expect(() => buildPrompt()).not.toThrow();
    expect(() => buildPrompt({})).not.toThrow();
    expect(() => buildPrompt(null)).not.toThrow();
    const p = buildPrompt({});
    expect(p.length).toBeGreaterThan(0);
    expect(p.length).toBeLessThan(350);
    expect(p).toContain('360 equirectangular panorama');
  });
});

describe('pickStyleId', () => {
  const styles = [
    { id: 1, name: 'Fantasy Land' },
    { id: 2, name: 'Digital Painting' },
    { id: 3, name: 'Sci-Fi' },
    { id: 4, name: 'Anime Art Style' },
  ];

  it('fuzzy-matches preferred names in order', () => {
    expect(pickStyleId(styles)).toBe(2); // 'digital' first in defaults
    expect(pickStyleId(styles, ['sci-fi'])).toBe(3);
    expect(pickStyleId(styles, ['ANIME'])).toBe(4);
  });

  it('matches despite punctuation/case differences', () => {
    expect(pickStyleId([{ id: 9, name: 'SCIFI dreamscape' }], ['sci-fi'])).toBe(9);
  });

  it('falls back to the first usable id when nothing matches', () => {
    expect(pickStyleId(styles, ['watercolor'])).toBe(1);
  });

  it('falls back to 5 for empty or unusable lists', () => {
    expect(pickStyleId([])).toBe(5);
    expect(pickStyleId(null)).toBe(5);
    expect(pickStyleId(undefined)).toBe(5);
    expect(pickStyleId('nope')).toBe(5);
    expect(pickStyleId([null, 'x', { name: 'no id' }])).toBe(5);
  });

  it('skips malformed entries but uses valid ones', () => {
    expect(pickStyleId([null, { name: 'broken' }, { id: 7, name: 'Cyberpunk' }])).toBe(7);
  });
});

describe('skyboxAvailable / generateSkybox without a key', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('skyboxAvailable() is false and does not throw when no key is configured', () => {
    // vite's `define` substitutes __HAS_BLOCKADE__ as a literal boolean under vitest too,
    // so this asserts the no-key behavior rather than the global being absent.
    expect(() => skyboxAvailable()).not.toThrow();
    expect(skyboxAvailable()).toBe(false);
  });

  it('generateSkybox() resolves null immediately without any fetch', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network should not be touched');
    });
    vi.stubGlobal('fetch', fetchSpy);
    await expect(generateSkybox('a prompt')).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('generateSkybox() never rejects even with hostile opts', async () => {
    await expect(generateSkybox(null, { timeoutMs: -1, onProgress: 'nope' })).resolves.toBeNull();
  });
});
