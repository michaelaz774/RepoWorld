import { describe, it, expect } from 'vitest';
import {
  generateQuests,
  createQuestState,
  updateQuestProgress,
  activeQuests,
  questSummary,
  generateNpcs,
} from './quests.js';
import { buildCity } from './layout.js';
import { langForExt } from './types.js';

/* ------------------------------------------------------------------ */
/* Test world fixtures — real layout.js output plus synthetic edges/   */
/* hazards/plots, matching the shapes documented in types.js.          */
/* ------------------------------------------------------------------ */

function fileNode(path, size) {
  const parts = path.split('/');
  const name = parts[parts.length - 1];
  const dir = parts.slice(0, -1).join('/');
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
  return { path, name, dir, size, ext, lang: langForExt(ext) };
}

/** Deterministic LCG so synthetic corpora are stable across runs (no Math.random). */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function syntheticFiles(count, seed = 42) {
  const rng = makeRng(seed);
  const dirs = ['', 'src', 'src/lib', 'src/components', 'src/hooks', 'tests', 'docs', 'scripts'];
  const exts = ['js', 'ts', 'py', 'css', 'md', 'json'];
  const files = [];
  for (let i = 0; i < count; i++) {
    const dir = dirs[Math.floor(rng() * dirs.length)];
    const ext = exts[Math.floor(rng() * exts.length)];
    const size = Math.floor(rng() * rng() * 200000);
    const path = (dir ? dir + '/' : '') + 'file' + i + '.' + ext;
    files.push(fileNode(path, size));
  }
  return files;
}

/** layout.js doesn't emit plots/roads/paths yet in every code path we exercise
 *  here, so synthesize plausible ones matching the CityLayout shape. */
function attachExtras(layout) {
  const plots = layout.districts.map((d, i) => ({
    id: 'plot-' + d.name,
    x: d.x,
    z: d.z,
    w: Math.min(d.w, 6),
    d: Math.min(d.d, 6),
    kind: i % 3 === 0 ? 'park' : i % 3 === 1 ? 'plaza' : 'lot',
    district: d.name,
  }));
  return { ...layout, plots, roads: [], paths: [] };
}

function makeEdges(buildings, count) {
  const edges = [];
  for (let i = 0; i < count && i + 1 < buildings.length; i++) {
    edges.push({ from: buildings[i].id, to: buildings[i + 1].id, weight: 1 + (i % 5) });
  }
  return edges;
}

function makeHazards(buildings, count) {
  const hazards = [];
  for (let i = 0; i < count && i < buildings.length; i++) {
    hazards.push({
      id: 'issue-' + i,
      path: buildings[i].id,
      kind: 'issue',
      severity: 1 + (i % 10),
      title: 'Bug #' + i,
      reason: 'It breaks sometimes.',
      url: null,
      number: i,
      ageDays: i,
      comments: i,
    });
  }
  return hazards;
}

function makeWorld({ fileCount = 20, hazardCount = 5, edgeCount = 5, seed = 42 } = {}) {
  const files = syntheticFiles(fileCount, seed);
  const layout = attachExtras(buildCity(files));
  const edges = makeEdges(layout.buildings, edgeCount);
  const hazards = makeHazards(layout.buildings, hazardCount);
  return {
    repo: { owner: 'acme', repo: 'demo', branch: 'main' },
    layout,
    edges,
    hazards,
    skyboxUrl: null,
    summary: 'A demo repository used for testing quests and NPCs.',
    stats: { files: files.length, issues: hazardCount, prs: 0, risks: 0 },
  };
}

/* ------------------------------------------------------------------ */
/* generateQuests                                                       */
/* ------------------------------------------------------------------ */

describe('generateQuests', () => {
  it('is deterministic for the same world', () => {
    const world = makeWorld();
    expect(generateQuests(world)).toEqual(generateQuests(world));
  });

  it('never crashes on missing/empty data and returns []', () => {
    expect(generateQuests(null)).toEqual([]);
    expect(generateQuests(undefined)).toEqual([]);
    expect(generateQuests({})).toEqual([]);
    expect(generateQuests({ layout: { buildings: [] } })).toEqual([]);
    expect(generateQuests({ layout: null })).toEqual([]);
  });

  it('generates quests for a small repo', () => {
    const quests = generateQuests(makeWorld({ fileCount: 6, hazardCount: 0, edgeCount: 0 }));
    expect(quests.length).toBeGreaterThan(0);
  });

  it('generates quests for a large repo', () => {
    const quests = generateQuests(makeWorld({ fileCount: 350, hazardCount: 40, edgeCount: 30 }));
    expect(quests.length).toBeGreaterThan(0);
  });

  it('still produces quests (just no exterminator/boss) with zero hazards', () => {
    const quests = generateQuests(makeWorld({ fileCount: 15, hazardCount: 0, edgeCount: 3 }));
    expect(quests.length).toBeGreaterThan(0);
    expect(quests.some((q) => q.archetype === 'exterminator')).toBe(false);
    expect(quests.some((q) => q.archetype === 'boss')).toBe(false);
  });

  it('orders quests easiest-first (non-decreasing difficulty)', () => {
    const quests = generateQuests(makeWorld({ fileCount: 60, hazardCount: 10, edgeCount: 10 }));
    for (let i = 1; i < quests.length; i++) {
      expect(quests[i].difficulty).toBeGreaterThanOrEqual(quests[i - 1].difficulty);
    }
  });

  it('every quest objective references data that actually exists in the world', () => {
    const world = makeWorld({ fileCount: 80, hazardCount: 12, edgeCount: 10 });
    const quests = generateQuests(world);
    const npcs = generateNpcs(world, quests);
    const buildingIds = new Set(world.layout.buildings.map((b) => b.id));
    const districtNames = new Set(world.layout.districts.map((d) => d.name));
    const hazardIds = new Set(world.hazards.map((h) => h.id));

    expect(quests.length).toBeGreaterThan(0);
    for (const q of quests) {
      const o = q.objective;
      switch (o.type) {
        case 'visit':
          expect(buildingIds.has(o.target)).toBe(true);
          break;
        case 'visitSet':
          expect(o.targets.length).toBe(2);
          for (const t of o.targets) expect(buildingIds.has(t)).toBe(true);
          break;
        case 'districtCount':
          expect(o.pool.length).toBeGreaterThan(0);
          for (const n of o.pool) expect(districtNames.has(n)).toBe(true);
          expect(o.target).toBeLessThanOrEqual(o.pool.length);
          break;
        case 'killCount':
          expect(o.target).toBeGreaterThan(0);
          expect(o.target).toBeLessThanOrEqual(world.hazards.length);
          break;
        case 'killTarget':
          expect(hazardIds.has(o.target)).toBe(true);
          break;
        case 'talkCount':
          expect(o.target).toBeGreaterThan(0);
          expect(o.target).toBeLessThanOrEqual(npcs.length);
          break;
        default:
          throw new Error('unexpected objective type: ' + o.type);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* Quest state / progress                                              */
/* ------------------------------------------------------------------ */

describe('quest state & progress', () => {
  it('createQuestState starts everything incomplete', () => {
    const world = makeWorld({ fileCount: 40, hazardCount: 8, edgeCount: 6 });
    const quests = generateQuests(world);
    const state = createQuestState(quests);
    expect(state.quests.length).toBe(quests.length);
    const summary = questSummary(state);
    expect(summary.total).toBe(quests.length);
    expect(summary.completed).toBe(0);
    expect(summary.active).toBe(quests.length);
    expect(summary.nextHint).toBe(quests[0].hint);
  });

  it('advances a "visit" objective and is idempotent on repeat', () => {
    const world = makeWorld({ fileCount: 40, hazardCount: 8, edgeCount: 6 });
    const quests = generateQuests(world);
    const entryQuest = quests.find((q) => q.archetype === 'entry');
    expect(entryQuest).toBeTruthy();

    const state0 = createQuestState(quests);
    const event = { type: 'visit', path: entryQuest.objective.target };
    const state1 = updateQuestProgress(state0, event);
    expect(state1).not.toBe(state0);
    expect(activeQuests(state1).find((q) => q.id === entryQuest.id)).toBeUndefined();

    const state2 = updateQuestProgress(state1, event); // identical event again
    expect(state2).toBe(state1); // no change -> same reference
  });

  it('never throws on unknown/garbage events and leaves state unchanged', () => {
    const world = makeWorld({ fileCount: 20, hazardCount: 3, edgeCount: 2 });
    const quests = generateQuests(world);
    const state = createQuestState(quests);
    expect(() => updateQuestProgress(state, { type: 'somethingWeird', foo: 1 })).not.toThrow();
    expect(updateQuestProgress(state, { type: 'somethingWeird' })).toBe(state);
    expect(updateQuestProgress(state, null)).toBe(state);
    expect(updateQuestProgress(state, {})).toBe(state);
    expect(updateQuestProgress(null, { type: 'visit', path: 'x' })).toEqual({ quests: [], progress: {} });
  });

  it('districtCount advances per distinct district and ignores duplicates', () => {
    const world = makeWorld({ fileCount: 60, hazardCount: 6, edgeCount: 5 });
    const quests = generateQuests(world);
    const q = quests.find((qq) => qq.archetype === 'districts');
    expect(q).toBeTruthy();

    let state = createQuestState(quests);
    const [name] = q.objective.pool;
    state = updateQuestProgress(state, { type: 'district', name });
    state = updateQuestProgress(state, { type: 'district', name }); // duplicate, ignored
    const active = activeQuests(state).find((a) => a.id === q.id);
    expect(active.progress.current).toBe(1);
    expect(active.progress.target).toBe(q.objective.target);
  });

  it('killCount advances per distinct bug and killTarget requires the exact boss id', () => {
    const world = makeWorld({ fileCount: 50, hazardCount: 10, edgeCount: 5 });
    const quests = generateQuests(world);
    const exterm = quests.find((q) => q.archetype === 'exterminator');
    const boss = quests.find((q) => q.archetype === 'boss');
    expect(exterm).toBeTruthy();
    expect(boss).toBeTruthy();

    let state = createQuestState(quests);
    for (let i = 0; i < exterm.objective.target; i++) {
      state = updateQuestProgress(state, { type: 'bugKilled', bugId: 'issue-' + i, severity: 3 });
      state = updateQuestProgress(state, { type: 'bugKilled', bugId: 'issue-' + i, severity: 3 }); // dup
    }
    expect(activeQuests(state).find((a) => a.id === exterm.id)).toBeUndefined();

    // Killing an unrelated bug never satisfies the boss objective.
    state = updateQuestProgress(state, { type: 'bugKilled', bugId: 'not-the-boss', severity: 9 });
    expect(activeQuests(state).find((a) => a.id === boss.id)).toBeTruthy();

    state = updateQuestProgress(state, { type: 'bugKilled', bugId: boss.objective.target, severity: boss.objective.severity });
    expect(activeQuests(state).find((a) => a.id === boss.id)).toBeUndefined();
  });

  it('talkCount advances from talk events and completes at the target', () => {
    const world = makeWorld({ fileCount: 30, hazardCount: 4, edgeCount: 3 });
    const quests = generateQuests(world);
    const npcs = generateNpcs(world, quests);
    const q = quests.find((qq) => qq.archetype === 'locals');
    expect(q).toBeTruthy();

    let state = createQuestState(quests);
    for (let i = 0; i < q.objective.target; i++) {
      state = updateQuestProgress(state, { type: 'talk', npcId: npcs[i].id });
      state = updateQuestProgress(state, { type: 'talk', npcId: npcs[i].id }); // dup
    }
    expect(activeQuests(state).find((a) => a.id === q.id)).toBeUndefined();
  });

  it('visitSet ("follow the imports") needs both endpoints, in either order', () => {
    const world = makeWorld({ fileCount: 50, hazardCount: 5, edgeCount: 8 });
    const quests = generateQuests(world);
    const q = quests.find((qq) => qq.archetype === 'imports');
    expect(q).toBeTruthy();

    let state = createQuestState(quests);
    const [from, to] = q.objective.targets;
    state = updateQuestProgress(state, { type: 'visit', path: to });
    expect(activeQuests(state).find((a) => a.id === q.id).progress.current).toBe(1);
    state = updateQuestProgress(state, { type: 'visit', path: from });
    expect(activeQuests(state).find((a) => a.id === q.id)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* generateNpcs                                                        */
/* ------------------------------------------------------------------ */

describe('generateNpcs', () => {
  it('is deterministic for the same world + quests', () => {
    const world = makeWorld({ fileCount: 50, hazardCount: 10, edgeCount: 8 });
    const quests = generateQuests(world);
    expect(generateNpcs(world, quests)).toEqual(generateNpcs(world, quests));
  });

  it('never crashes on missing/empty data and returns []', () => {
    expect(generateNpcs(null, [])).toEqual([]);
    expect(generateNpcs({}, [])).toEqual([]);
    expect(generateNpcs({ layout: { buildings: [], districts: [] } }, [])).toEqual([]);
    expect(generateNpcs(undefined, undefined)).toEqual([]);
  });

  it('never places an NPC inside a building footprint', () => {
    const world = makeWorld({ fileCount: 120, hazardCount: 15, edgeCount: 10 });
    const quests = generateQuests(world);
    const npcs = generateNpcs(world, quests);
    expect(npcs.length).toBeGreaterThan(0);
    const buildings = world.layout.buildings;
    for (const npc of npcs) {
      for (const b of buildings) {
        const hw = (b.w || 1) / 2;
        const hd = (b.d || 1) / 2;
        const inside = Math.abs(npc.x - b.x) < hw - 1e-6 && Math.abs(npc.z - b.z) < hd - 1e-6;
        expect(inside).toBe(false);
      }
    }
  });

  it('gives every NPC non-empty dialogue that references real repo data', () => {
    const world = makeWorld({ fileCount: 60, hazardCount: 10, edgeCount: 6 });
    const quests = generateQuests(world);
    const npcs = generateNpcs(world, quests);
    expect(npcs.length).toBeGreaterThan(0);
    for (const npc of npcs) {
      expect(Array.isArray(npc.lines)).toBe(true);
      expect(npc.lines.length).toBeGreaterThan(0);
      for (const line of npc.lines) {
        expect(typeof line).toBe('string');
        expect(line.length).toBeGreaterThan(0);
      }
      expect(typeof npc.id).toBe('string');
      expect(Number.isFinite(npc.x)).toBe(true);
      expect(Number.isFinite(npc.z)).toBe(true);
      expect(typeof npc.name).toBe('string');
      expect(typeof npc.role).toBe('string');
    }
    const guide = npcs.find((n) => n.role === 'Guide');
    expect(guide).toBeTruthy();
    expect(guide.lines.join(' ')).toContain('acme/demo');
  });

  it('assigns a Guide and a Mechanic when hazards exist', () => {
    const world = makeWorld({ fileCount: 100, hazardCount: 20, edgeCount: 10 });
    const quests = generateQuests(world);
    const npcs = generateNpcs(world, quests);
    const roles = new Set(npcs.map((n) => n.role));
    expect(roles.has('Guide')).toBe(true);
    expect(roles.has('Mechanic')).toBe(true);
  });

  it('the "locals" quest target never exceeds the actual NPC count', () => {
    const world = makeWorld({ fileCount: 30, hazardCount: 4, edgeCount: 3 });
    const quests = generateQuests(world);
    const npcs = generateNpcs(world, quests);
    const q = quests.find((qq) => qq.archetype === 'locals');
    expect(q).toBeTruthy();
    expect(q.objective.target).toBeLessThanOrEqual(npcs.length);
  });
});
