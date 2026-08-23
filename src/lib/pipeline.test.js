import { describe, it, expect } from 'vitest';
import { syntheticEdges } from './pipeline.js';
import { MOCK_WORLD_INPUT } from './mockData.js';
import { buildCity } from './layout.js';
import { buildHazards } from './hazards.js';
import { mockRisks } from './greptile.js';

describe('syntheticEdges', () => {
  it('returns [] for degenerate input', () => {
    expect(syntheticEdges([])).toEqual([]);
    expect(syntheticEdges(null)).toEqual([]);
    expect(syntheticEdges([{ path: 'only.js' }])).toEqual([]);
  });

  it('is deterministic', () => {
    const a = syntheticEdges(MOCK_WORLD_INPUT.files);
    const b = syntheticEdges(MOCK_WORLD_INPUT.files);
    expect(a).toEqual(b);
  });

  it('produces valid, self-edge-free edges referencing real files', () => {
    const edges = syntheticEdges(MOCK_WORLD_INPUT.files);
    const paths = new Set(MOCK_WORLD_INPUT.files.map((f) => f.path));
    expect(edges.length).toBeGreaterThan(10);
    expect(edges.length).toBeLessThanOrEqual(250);
    for (const e of edges) {
      expect(paths.has(e.from)).toBe(true);
      expect(paths.has(e.to)).toBe(true);
      expect(e.from).not.toBe(e.to);
      expect(e.weight).toBeGreaterThanOrEqual(1);
      expect(e.weight).toBeLessThanOrEqual(5);
    }
  });

  it('has no duplicate from/to pairs', () => {
    const edges = syntheticEdges(MOCK_WORLD_INPUT.files);
    const seen = new Set(edges.map((e) => `${e.from}->${e.to}`));
    expect(seen.size).toBe(edges.length);
  });
});

// End-to-end check of the offline path the demo actually runs, wiring together every
// agent's module: fixture -> city -> risks -> hazards -> edges.
describe('offline demo world assembly', () => {
  const { files, issues, prs } = MOCK_WORLD_INPUT;
  const layout = buildCity(files);
  const risks = mockRisks(files, 10);
  const hazards = buildHazards({ issues, prs, risks, buildings: layout.buildings });
  const edges = syntheticEdges(files);

  it('builds a city with one building per file', () => {
    expect(layout.buildings.length).toBe(files.length);
    expect(layout.districts.length).toBeGreaterThan(1);
  });

  it('produces hazards that all land on real buildings', () => {
    const ids = new Set(layout.buildings.map((b) => b.id));
    expect(hazards.length).toBeGreaterThan(0);
    for (const h of hazards) {
      expect(h.path).toBeTruthy();
      expect(ids.has(h.path)).toBe(true);
      expect(h.severity).toBeGreaterThanOrEqual(1);
      expect(h.severity).toBeLessThanOrEqual(10);
      expect(['issue', 'pr', 'risk']).toContain(h.kind);
    }
  });

  it('covers all three hazard kinds so the demo shows every visual', () => {
    const kinds = new Set(hazards.map((h) => h.kind));
    expect(kinds.has('issue')).toBe(true);
    expect(kinds.has('pr')).toBe(true);
    expect(kinds.has('risk')).toBe(true);
  });

  it('produces edges whose endpoints are all real buildings', () => {
    const ids = new Set(layout.buildings.map((b) => b.id));
    for (const e of edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });
});
