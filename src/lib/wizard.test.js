import { describe, it, expect } from 'vitest';
import {
  buildWizardContext,
  buildSystemPrompt,
  createWizardTools,
  districtRollup,
  worldReadiness,
  WIZARD_TOOL_NAMES,
  WIZARD_LIMITS,
  trimHistory,
  pickWizardHome,
  stepWizardBody,
  angleDelta,
  yawToward,
  collideWizardAxis,
  WIZARD_RADIUS,
  WIZARD_ARRIVE_EPS,
  WIZARD_FOLLOW_GAP,
  buildPathGraph,
  planWizardRoute,
  segmentHitsBuilding,
  shouldReplan,
  isAimedAtWizard,
} from './wizard.js';
import { buildCity } from './layout.js';
import { MOCK_WORLD_INPUT } from './mockData.js';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function building(path, over = {}) {
  const district = path.includes('/') ? path.split('/')[0] : '/';
  return {
    id: path, path, name: path.split('/').pop(), dir: district,
    size: 1000, ext: 'js', lang: 'JavaScript',
    x: 10, z: -20, w: 4, d: 4, height: 8, color: '#f1e05a', district,
    ...over,
  };
}

function hazard(id, over = {}) {
  return {
    id, path: 'src/a.js', kind: 'issue', severity: 5,
    title: `hazard ${id}`, reason: 'because', url: null, number: 1,
    ageDays: 3, comments: 0, ...over,
  };
}

function world(over = {}) {
  return {
    repo: { owner: 'acme', repo: 'pulse', branch: 'main' },
    layout: {
      buildings: [
        building('README.md', { district: '/', lang: 'Markdown', size: 500 }),
        building('src/a.js', { x: 30, z: 5, size: 4000 }),
        building('src/b.js', { x: 34, z: 5, size: 2000 }),
        building('tests/a.test.js', { x: -12, z: 40, lang: 'JavaScript' }),
      ],
      districts: [
        { name: '/', x: 0, z: 0, w: 20, d: 20, color: '#fff' },
        { name: 'src', x: 32, z: 5, w: 30, d: 30, color: '#fff' },
        { name: 'tests', x: -12, z: 40, w: 20, d: 20, color: '#fff' },
      ],
      bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
      roads: [], plots: [], paths: [{ x: 0, z: 0, links: [] }],
    },
    edges: [{ from: 'src/a.js', to: 'src/b.js', weight: 2 }],
    hazards: [hazard('issue-1', { severity: 9 }), hazard('risk-1', { kind: 'risk', severity: 3, path: 'src/b.js' })],
    skyboxUrl: null,
    summary: 'a repo',
    meta: { description: 'desc', language: 'JavaScript', stars: 12, topics: ['a'], readme: 'hello' },
    stats: { files: 4, issues: 1, prs: 0, risks: 1 },
    spawn: { x: 0, y: 2, z: 8 },
    ...over,
  };
}

/** Tool results are JSON strings; parse for assertions. */
async function call(tools, name, args = {}) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return JSON.parse(await tool.run(args));
}

function toolsFor(w, over = {}) {
  return createWizardTools({
    getWorld: () => w,
    getChase: () => null,
    getPlayer: () => ({ x: 0, z: 0 }),
    readFile: async (p) => `// source of ${p}`,
    control: {},
    ...over,
  });
}

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

describe('districtRollup', () => {
  it('groups files by district with counts, bytes and dominant language', () => {
    const roll = districtRollup(world().layout.buildings);
    const src = roll.find((d) => d.district === 'src');
    expect(src).toEqual({ district: 'src', files: 2, bytes: 6000, mainLang: 'JavaScript' });
    expect(roll[0].files).toBeGreaterThanOrEqual(roll[roll.length - 1].files); // sorted desc
  });

  it('never throws on garbage', () => {
    expect(() => districtRollup(null)).not.toThrow();
    expect(() => districtRollup([null, {}, { district: 5 }])).not.toThrow();
    expect(districtRollup(null)).toEqual([]);
  });
});

describe('worldReadiness', () => {
  it('reports heuristic risks until greptileLive is set', () => {
    expect(worldReadiness(world()).riskAnalysis).toBe('heuristic');
    expect(worldReadiness(world({ greptileLive: true })).riskAnalysis).toBe('greptile');
  });

  it('distinguishes "no edges yet" from a loaded graph', () => {
    expect(worldReadiness(world({ edges: [] })).dependenciesReady).toBe(false);
    expect(worldReadiness(world()).dependenciesReady).toBe(true);
  });

  it('never throws on a null world', () => {
    expect(() => worldReadiness(null)).not.toThrow();
    expect(worldReadiness(null).dependenciesReady).toBe(false);
  });
});

describe('buildWizardContext', () => {
  it('includes the fields the wizard needs to orient itself', () => {
    const ctx = buildWizardContext(world());
    expect(ctx.repo.owner).toBe('acme');
    expect(ctx.districts).toHaveLength(3);
    expect(ctx.districtRollup.length).toBeGreaterThan(0);
    expect(ctx.buildingCount).toBe(4);
    expect(ctx.buildings[0]).toHaveLength(5); // [path,x,z,height,district]
  });

  it('sorts hazards worst-first and caps them', () => {
    const many = Array.from({ length: 40 }, (_, i) => hazard(`h${i}`, { severity: i % 10 }));
    const ctx = buildWizardContext(world({ hazards: many }));
    expect(ctx.topHazards.length).toBe(WIZARD_LIMITS.MAX_CONTEXT_HAZARDS);
    for (let i = 1; i < ctx.topHazards.length; i++) {
      expect(ctx.topHazards[i - 1].severity).toBeGreaterThanOrEqual(ctx.topHazards[i].severity);
    }
  });

  it('drops layout.paths — the biggest field and worthless to the wizard', () => {
    const json = JSON.stringify(buildWizardContext(world()));
    expect(json).not.toContain('"paths"');
    expect(json).not.toContain('"roads"');
  });

  it('truncates the building list on a big repo and says so', () => {
    const big = Array.from({ length: 350 }, (_, i) => building(`src/f${i}.js`));
    const ctx = buildWizardContext(world({ layout: { ...world().layout, buildings: big } }));
    expect(ctx.buildings.length).toBe(WIZARD_LIMITS.MAX_CONTEXT_BUILDINGS);
    expect(ctx.buildingsTruncated).toBe(true);
    expect(ctx.buildingCount).toBe(350);
  });

  it('caps the README so a long one cannot dominate the prompt', () => {
    const ctx = buildWizardContext(world({ meta: { readme: 'x'.repeat(50000) } }));
    expect(ctx.meta.readme.length).toBeLessThanOrEqual(WIZARD_LIMITS.MAX_README_CHARS + 1);
  });

  it('never throws on degenerate worlds', () => {
    for (const w of [null, undefined, {}, { layout: null }, { layout: { buildings: null } }]) {
      expect(() => buildWizardContext(w)).not.toThrow();
    }
  });
});

describe('buildSystemPrompt', () => {
  it('stays within a sane token budget for a small repo', () => {
    const prompt = buildSystemPrompt(world());
    // ~3.7 bytes/token; this fixture is tiny, so this is a regression guard only.
    expect(prompt.length / 3.7).toBeLessThan(3000);
  });

  it('stays bounded on a 350-file repo', () => {
    const big = Array.from({ length: 350 }, (_, i) => building(`src/f${i}.js`));
    const prompt = buildSystemPrompt(world({
      layout: { ...world().layout, buildings: big },
      meta: { readme: 'x'.repeat(50000) },
    }));
    expect(prompt.length / 3.7).toBeLessThan(9000);
  });

  it('warns the wizard when risks are only heuristic', () => {
    expect(buildSystemPrompt(world())).toContain('HEURISTIC');
    expect(buildSystemPrompt(world({ greptileLive: true }))).not.toContain('HEURISTIC');
  });

  it('warns that empty edges means "not loaded", not "no imports"', () => {
    expect(buildSystemPrompt(world({ edges: [] }))).toContain('not the same as');
  });

  it('never throws on a null world', () => {
    expect(() => buildSystemPrompt(null)).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

describe('createWizardTools', () => {
  it('exposes exactly the documented tool set', () => {
    const names = toolsFor(world()).map((t) => t.name);
    expect(names.sort()).toEqual([...WIZARD_TOOL_NAMES].sort());
  });

  it('gives every tool a name, description and object schema', () => {
    for (const t of toolsFor(world())) {
      expect(typeof t.name).toBe('string');
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe('object');
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(typeof t.run).toBe('function');
    }
  });

  it('every tool returns a JSON string, even with no arguments', async () => {
    for (const t of toolsFor(world())) {
      const out = await t.run({});
      expect(typeof out).toBe('string');
      expect(() => JSON.parse(out)).not.toThrow();
    }
  });

  it('reads the world through the accessor, so a republish is picked up', async () => {
    let current = world();
    const tools = createWizardTools({ getWorld: () => current, getPlayer: () => ({}) });
    expect((await call(tools, 'list_files')).total).toBe(4);
    current = world({ layout: { ...current.layout, buildings: [building('only.js')] } });
    expect((await call(tools, 'list_files')).total).toBe(1);
  });

  describe('list_files / search_paths', () => {
    it('filters by district and caps the limit', async () => {
      const tools = toolsFor(world());
      expect((await call(tools, 'list_files', { district: 'src' })).count).toBe(2);
      expect((await call(tools, 'list_files', { limit: 1 })).count).toBe(1);
      expect((await call(tools, 'list_files', { limit: 99999 })).count).toBeLessThanOrEqual(WIZARD_LIMITS.MAX_TOOL_FILES);
    });

    it('matches paths case-insensitively', async () => {
      const tools = toolsFor(world());
      expect((await call(tools, 'search_paths', { query: 'SRC/A' })).matches).toContain('src/a.js');
      expect((await call(tools, 'search_paths', { query: '' })).matches).toEqual([]);
      expect((await call(tools, 'search_paths', { query: 'nope' })).count).toBe(0);
    });
  });

  describe('read_file', () => {
    it('returns source for a real path', async () => {
      const res = await call(toolsFor(world()), 'read_file', { path: 'src/a.js' });
      expect(res.source).toContain('src/a.js');
    });

    it('refuses a path that is not in the repo instead of fetching it', async () => {
      let fetched = false;
      const tools = toolsFor(world(), { readFile: async () => { fetched = true; return 'x'; } });
      const res = await call(tools, 'read_file', { path: '../../etc/passwd' });
      expect(res.error).toMatch(/No file at/);
      expect(fetched).toBe(false);
    });

    it('truncates a huge file', async () => {
      const tools = toolsFor(world(), { readFile: async () => 'y'.repeat(100000) });
      const res = await call(tools, 'read_file', { path: 'src/a.js' });
      expect(res.truncated).toBe(true);
      expect(res.source.length).toBeLessThanOrEqual(WIZARD_LIMITS.MAX_FILE_CHARS + 1);
    });

    it('explains an empty result rather than looking broken (demo world)', async () => {
      const tools = toolsFor(world(), { readFile: async () => '' });
      const res = await call(tools, 'read_file', { path: 'src/a.js' });
      expect(res.note).toMatch(/demo world/i);
    });

    it('turns a thrown fetch error into a tool result, never a rejection', async () => {
      const tools = toolsFor(world(), { readFile: async () => { throw new Error('offline'); } });
      const res = await call(tools, 'read_file', { path: 'src/a.js' });
      expect(res.error).toContain('offline');
    });

    it('reports unavailability when there is no fetcher at all', async () => {
      const tools = toolsFor(world(), { readFile: null });
      expect((await call(tools, 'read_file', { path: 'src/a.js' })).error).toMatch(/unavailable/i);
    });
  });

  describe('describe_building / describe_district', () => {
    it('joins hazards and both import directions onto a file', async () => {
      const res = await call(toolsFor(world()), 'describe_building', { path: 'src/a.js' });
      expect(res.hazards.map((h) => h.id)).toContain('issue-1');
      expect(res.imports).toContain('src/b.js');
      expect(res.importedBy).toEqual([]);
    });

    it('errors helpfully on an unknown path', async () => {
      expect((await call(toolsFor(world()), 'describe_building', { path: 'nope' })).error).toMatch(/search_paths/);
    });

    it('flags unloaded edges rather than implying there are none', async () => {
      const res = await call(toolsFor(world({ edges: [] })), 'describe_building', { path: 'src/a.js' });
      expect(res.note).toMatch(/not finished loading/);
    });

    it('returns all districts when given no name, one when named', async () => {
      const tools = toolsFor(world());
      expect((await call(tools, 'describe_district')).districts).toHaveLength(3);
      const src = await call(tools, 'describe_district', { name: 'src' });
      expect(src.files).toBe(2);
      expect(src.biggestFiles[0].path).toBe('src/a.js');
      expect((await call(tools, 'describe_district', { name: 'zzz' })).error).toMatch(/Known:/);
    });
  });

  describe('get_risks', () => {
    it('sorts worst-first, filters by kind and reports readiness', async () => {
      const tools = toolsFor(world());
      const all = await call(tools, 'get_risks');
      expect(all.hazards[0].id).toBe('issue-1');
      expect(all.riskAnalysis).toBe('heuristic');
      expect((await call(tools, 'get_risks', { kind: 'risk' })).hazards).toHaveLength(1);
    });
  });

  describe('locate', () => {
    it('finds a file and a district and measures from the player', async () => {
      const tools = toolsFor(world(), { getPlayer: () => ({ x: 30, z: 0 }) });
      const f = await call(tools, 'locate', { target: 'src/a.js' });
      expect(f.kind).toBe('file');
      expect(f.distanceFromPlayer).toBe(5);
      expect((await call(tools, 'locate', { target: 'tests' })).kind).toBe('district');
      expect((await call(tools, 'locate', { target: 'nothing' })).error).toBeTruthy();
    });
  });

  describe('movement', () => {
    it('move_to drives the control surface', async () => {
      const calls = [];
      const tools = toolsFor(world(), { control: { moveTo: (x, z) => { calls.push([x, z]); return { moving: true }; } } });
      expect((await call(tools, 'move_to', { x: 5, z: -7 })).moving).toBe(true);
      expect(calls).toEqual([[5, -7]]);
    });

    it('follow_player toggles following', async () => {
      let following = null;
      const tools = toolsFor(world(), { control: { setFollow: (v) => { following = v; } } });
      expect((await call(tools, 'follow_player', { follow: true })).following).toBe(true);
      expect(following).toBe(true);
      await call(tools, 'follow_player', { follow: false });
      expect(following).toBe(false);
    });

    it('says so rather than throwing when there is no body to move', async () => {
      const tools = toolsFor(world(), { control: {} });
      expect((await call(tools, 'move_to', { x: 1, z: 1 })).error).toBeTruthy();
      expect((await call(tools, 'follow_player', { follow: true })).error).toBeTruthy();
    });
  });

  describe('live state', () => {
    it('reports the chase sim when it exists and degrades when it does not', async () => {
      expect((await call(toolsFor(world()), 'list_live_bugs')).running).toBe(false);
      const chase = {
        bugs: [
          { id: 'b1', title: 'boom', kind: 'issue', severity: 4, x: 1, z: 2, state: 'alive', buildingId: 'src/a.js' },
          { id: 'b2', state: 'dead', x: 0, z: 0 },
        ],
        greptiles: [{ id: 'g1', x: 3, z: 4, mode: 'roam', targetId: null }],
      };
      const res = await call(toolsFor(world(), { getChase: () => chase }), 'list_live_bugs');
      expect(res.aliveCount).toBe(1);
      expect(res.bugs[0].id).toBe('b1');
      expect(res.greptiles[0].id).toBe('g1');
    });

    it('player_position includes the wizard and the gap between them', async () => {
      const tools = toolsFor(world(), {
        getPlayer: () => ({ x: 0, z: 0, focusedBuilding: 'src/a.js', driving: true }),
        control: { position: () => ({ x: 3, z: 4, following: true }) },
      });
      const res = await call(tools, 'player_position');
      expect(res.player.lookingAt).toBe('src/a.js');
      expect(res.player.driving).toBe(true);
      expect(res.distance).toBe(5);
      expect(res.wizard.following).toBe(true);
    });
  });

  it('survives a completely empty world without throwing', async () => {
    const tools = createWizardTools({ getWorld: () => null, getPlayer: () => ({}) });
    for (const t of tools) {
      const out = await t.run({ path: 'x', target: 'x', query: 'x', x: 0, z: 0, follow: true });
      expect(() => JSON.parse(out)).not.toThrow();
    }
  });
});

/* ------------------------------------------------------------------ */
/* History trimming                                                    */
/* ------------------------------------------------------------------ */

describe('trimHistory', () => {
  const user = (t) => ({ role: 'user', content: t });
  const assistant = (t) => ({ role: 'assistant', content: t });
  const toolResult = () => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'y' }] });

  it('leaves a short conversation alone', () => {
    const msgs = [user('a'), assistant('b')];
    expect(trimHistory(msgs, 40)).toEqual(msgs);
  });

  it('drops the oldest turns past the cap', () => {
    const msgs = Array.from({ length: 60 }, (_, i) => (i % 2 ? assistant(`a${i}`) : user(`u${i}`)));
    const out = trimHistory(msgs, 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out[out.length - 1]).toEqual(msgs[msgs.length - 1]);
  });

  it('never starts on a tool_result, which would orphan its tool_use', () => {
    const msgs = [user('old'), assistant('call'), toolResult(), assistant('answer'), user('next')];
    const out = trimHistory(msgs, 3);
    expect(out[0].role).toBe('user');
    const startsWithToolResult = Array.isArray(out[0].content)
      && out[0].content.some((b) => b.type === 'tool_result');
    expect(startsWithToolResult).toBe(false);
  });

  it('never starts on an assistant turn', () => {
    // Trimming to 2 leaves two assistant turns, both of which must be walked
    // off: an empty transcript is correct, an invalid one is not.
    const msgs = [user('a'), assistant('b'), assistant('c')];
    const out = trimHistory(msgs, 2);
    expect(out.length === 0 || out[0].role === 'user').toBe(true);
  });

  it('keeps a valid opening turn whenever one survives', () => {
    const msgs = [user('old'), assistant('b'), user('keep'), assistant('c')];
    const out = trimHistory(msgs, 3);
    expect(out[0]).toEqual(user('keep'));
  });

  it('returns empty rather than throwing when nothing survives the walk', () => {
    expect(() => trimHistory([assistant('a'), assistant('b')], 1)).not.toThrow();
    expect(trimHistory([assistant('a'), assistant('b')], 1)).toEqual([]);
  });

  it('never throws on garbage', () => {
    expect(trimHistory(null, 5)).toEqual([]);
    expect(() => trimHistory([null, undefined, 3], 1)).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* Wizard placement                                                    */
/* ------------------------------------------------------------------ */

describe('pickWizardHome', () => {
  it('stands clear of every building footprint', () => {
    const layout = world().layout;
    const home = pickWizardHome(layout, { x: 0, z: 0 });
    for (const b of layout.buildings) {
      const clearX = Math.abs(home.x - b.x) > b.w / 2;
      const clearZ = Math.abs(home.z - b.z) > b.d / 2;
      expect(clearX || clearZ).toBe(true);
    }
  });

  it('stays within a short walk of the spawn', () => {
    const home = pickWizardHome(world().layout, { x: 10, z: -10 }, 14);
    const d = Math.hypot(home.x - 10, home.z + 10);
    expect(d).toBeGreaterThanOrEqual(13);
    expect(d).toBeLessThanOrEqual(40);
  });

  it('is deterministic for a given layout and spawn', () => {
    const layout = world().layout;
    expect(pickWizardHome(layout, { x: 3, z: 4 })).toEqual(pickWizardHome(layout, { x: 3, z: 4 }));
  });

  it('still returns a finite spot when the whole area is built over', () => {
    const wall = Array.from({ length: 20 }, (_, i) => building(`w${i}.js`, { x: 0, z: 0, w: 500, d: 500 }));
    const home = pickWizardHome({ buildings: wall }, { x: 0, z: 0 });
    expect(Number.isFinite(home.x)).toBe(true);
    expect(Number.isFinite(home.z)).toBe(true);
  });

  it('never throws on degenerate input', () => {
    expect(() => pickWizardHome(null, null)).not.toThrow();
    expect(() => pickWizardHome({ buildings: [null, {}] }, { x: NaN, z: NaN })).not.toThrow();
    const home = pickWizardHome(null, null);
    expect(Number.isFinite(home.x) && Number.isFinite(home.z)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Body steering                                                       */
/* ------------------------------------------------------------------ */

describe('stepWizardBody', () => {
  const body = (over = {}) => ({
    x: 0, z: 0, yaw: 0, targetX: null, targetZ: null, following: false, ...over,
  });
  /** Run n frames at 60fps. */
  const run = (b, input, n = 60) => {
    for (let i = 0; i < n; i++) stepWizardBody(b, input, 1 / 60);
    return b;
  };
  const dist = (b, x, z) => Math.hypot(b.x - x, b.z - z);

  it('walks toward a target and stops on arrival', () => {
    const b = body({ targetX: 20, targetZ: 0 });
    run(b, { playerX: 0, playerZ: 0 }, 60 * 10);
    expect(dist(b, 20, 0)).toBeLessThanOrEqual(WIZARD_ARRIVE_EPS);
    expect(b.targetX).toBe(null);   // cleared once arrived
    expect(b.moving).toBe(false);
  });

  it('follows the player but keeps a respectful gap', () => {
    const b = body({ x: 40, z: 0, following: true });
    run(b, { playerX: 0, playerZ: 0 }, 60 * 30);
    const gap = dist(b, 0, 0);
    expect(gap).toBeGreaterThan(WIZARD_FOLLOW_GAP * 0.6);
    expect(gap).toBeLessThan(WIZARD_FOLLOW_GAP * 1.4);
    expect(b.following).toBe(true);  // following is a mode, not a one-shot
  });

  describe('listening (the player is typing)', () => {
    it('stops dead, wherever it was walking', () => {
      const b = body({ targetX: 100, targetZ: 0 });
      run(b, { playerX: 0, playerZ: 0 }, 60);       // get him moving
      const { x, z } = b;
      expect(x).toBeGreaterThan(0);
      run(b, { playerX: 0, playerZ: 0, listening: true }, 60 * 3);
      expect(b.x).toBe(x);
      expect(b.z).toBe(z);
      expect(b.moving).toBe(false);
    });

    it('turns to face the player', () => {
      // Player due +X of him; yawToward is the angle that faces them.
      const b = body({ x: 0, z: 0, yaw: Math.PI });
      run(b, { playerX: 10, playerZ: 0, listening: true }, 60);
      expect(b.yaw).toBeCloseTo(yawToward(0, 0, 10, 0), 2);
    });

    it('faces the player from any starting angle', () => {
      for (const start of [0, 1.5, -2.2, Math.PI, -Math.PI + 0.01]) {
        for (const [px, pz] of [[10, 0], [-10, 0], [0, 10], [0, -10], [7, -7]]) {
          const b = body({ yaw: start });
          run(b, { playerX: px, playerZ: pz, listening: true }, 90);
          expect(Math.abs(angleDelta(b.yaw, yawToward(0, 0, px, pz)))).toBeLessThan(0.02);
        }
      }
    });

    it('takes the short way round rather than spinning the long way', () => {
      // Facing -Z (yaw 0); player is slightly clockwise. Yaw must not wrap
      // through a full turn to get there.
      const b = body({ yaw: 3.0 });
      const want = yawToward(0, 0, 0, 10);   // faces +Z, i.e. yaw ~PI
      let maxStep = 0;
      let prev = b.yaw;
      for (let i = 0; i < 60; i++) {
        stepWizardBody(b, { playerX: 0, playerZ: 10, listening: true }, 1 / 60);
        maxStep = Math.max(maxStep, Math.abs(angleDelta(prev, b.yaw)));
        prev = b.yaw;
      }
      expect(Math.abs(angleDelta(b.yaw, want))).toBeLessThan(0.05);
      expect(maxStep).toBeLessThan(0.5);   // smooth, never a jump
    });

    it('remembers where it was going and resumes afterwards', () => {
      const b = body({ targetX: 30, targetZ: 0 });
      run(b, { playerX: 0, playerZ: 0 }, 30);
      const paused = b.x;
      run(b, { playerX: 0, playerZ: 0, listening: true }, 60 * 2);
      expect(b.x).toBe(paused);
      expect(b.targetX).toBe(30);          // target survived the pause
      run(b, { playerX: 0, playerZ: 0 }, 60 * 10);
      expect(dist(b, 30, 0)).toBeLessThanOrEqual(WIZARD_ARRIVE_EPS);
    });

    it('pauses following without forgetting it', () => {
      const b = body({ x: 40, z: 0, following: true });
      const before = { x: b.x, z: b.z };
      run(b, { playerX: 0, playerZ: 0, listening: true }, 60 * 2);
      expect(b.x).toBe(before.x);
      expect(b.following).toBe(true);
      run(b, { playerX: 0, playerZ: 0 }, 60 * 30);
      expect(dist(b, 0, 0)).toBeLessThan(WIZARD_FOLLOW_GAP * 1.4);
    });
  });

  it('turns toward the player when idle and nearby', () => {
    const b = body({ yaw: 0 });
    run(b, { playerX: 0, playerZ: 10, near: true }, 120);
    expect(Math.abs(angleDelta(b.yaw, yawToward(0, 0, 0, 10)))).toBeLessThan(0.1);
  });

  it('holds still when idle and no one is near', () => {
    const b = body({ yaw: 0.4 });
    run(b, { playerX: 100, playerZ: 100, near: false }, 120);
    expect(b.x).toBe(0);
    expect(b.yaw).toBe(0.4);
  });

  it('clamps dt so a hitch cannot teleport him', () => {
    const small = stepWizardBody(body({ targetX: 999, targetZ: 0 }), { playerX: 0, playerZ: 0 }, 0.05);
    const huge = stepWizardBody(body({ targetX: 999, targetZ: 0 }), { playerX: 0, playerZ: 0 }, 30);
    expect(huge.x).toBeCloseTo(small.x, 10);
  });

  it('never NaNs or throws on garbage', () => {
    expect(() => stepWizardBody(null, {}, 0.016)).not.toThrow();
    const b = body({ x: NaN, z: undefined, yaw: NaN, targetX: 'x', targetZ: null });
    for (const input of [{}, { playerX: NaN, playerZ: NaN, listening: true }, { playerX: 5, playerZ: 5 }]) {
      run(b, input, 30);
      expect(Number.isFinite(b.x)).toBe(true);
      expect(Number.isFinite(b.z)).toBe(true);
      expect(Number.isFinite(b.yaw)).toBe(true);
    }
  });

  it('is deterministic', () => {
    const a = body({ targetX: 25, targetZ: -12 });
    const c = body({ targetX: 25, targetZ: -12 });
    for (let i = 0; i < 300; i++) {
      const input = { playerX: i * 0.1, playerZ: -i * 0.05, listening: i % 40 === 0 };
      stepWizardBody(a, input, 1 / 60);
      stepWizardBody(c, input, 1 / 60);
    }
    expect(a.x).toBe(c.x);
    expect(a.z).toBe(c.z);
    expect(a.yaw).toBe(c.yaw);
  });
});

describe('wizard yaw stays canonical', () => {
  it('never drifts outside (-PI, PI] however long it turns', () => {
    const b = { x: 0, z: 0, yaw: 0, targetX: null, targetZ: null, following: false };
    // Player circles him for ten seconds while he listens.
    for (let i = 0; i < 600; i++) {
      const th = (i / 60) * Math.PI;
      stepWizardBody(b, {
        playerX: Math.cos(th) * 10, playerZ: Math.sin(th) * 10, listening: true,
      }, 1 / 60);
      expect(b.yaw).toBeGreaterThan(-Math.PI - 1e-9);
      expect(b.yaw).toBeLessThanOrEqual(Math.PI + 1e-9);
    }
  });
});

describe('stepWizardBody gait', () => {
  const body = (over = {}) => ({
    x: 0, z: 0, yaw: 0, phase: 0, targetX: null, targetZ: null, following: false, ...over,
  });

  it('advances the stride phase only while actually walking', () => {
    const b = body({ targetX: 40, targetZ: 0 });
    for (let i = 0; i < 60; i++) stepWizardBody(b, { playerX: 0, playerZ: 0 }, 1 / 60);
    expect(b.phase).not.toBe(0);
    expect(b.moving).toBe(true);

    const held = b.phase;
    for (let i = 0; i < 60; i++) stepWizardBody(b, { playerX: 0, playerZ: 0, listening: true }, 1 / 60);
    expect(b.phase).toBe(held);   // no moonwalking on the spot
    expect(b.moving).toBe(false);
  });

  it('ties stride to distance covered, not to elapsed time', () => {
    // Same elapsed time at different frame rates must give the same phase.
    // The target is far enough that both are still walking at the end: right at
    // the arrival threshold the final partial step quantises differently per
    // frame rate, which is about arrival, not about gait.
    const a = body({ targetX: 500, targetZ: 0 });
    const c = body({ targetX: 500, targetZ: 0 });
    for (let i = 0; i < 200; i++) stepWizardBody(a, { playerX: 0, playerZ: 0 }, 1 / 60);
    for (let i = 0; i < 100; i++) stepWizardBody(c, { playerX: 0, playerZ: 0 }, 1 / 30);
    expect(a.x).toBeCloseTo(c.x, 6);
    expect(a.phase).toBeCloseTo(c.phase, 6);
  });

  it('keeps the phase wrapped so it never grows without bound', () => {
    const b = body({ targetX: 5000, targetZ: 0 });
    for (let i = 0; i < 60 * 120; i++) stepWizardBody(b, { playerX: 0, playerZ: 0 }, 1 / 60);
    expect(b.phase).toBeGreaterThan(-Math.PI - 1e-9);
    expect(b.phase).toBeLessThanOrEqual(Math.PI + 1e-9);
  });

  it('starts a gait even if phase was never initialised', () => {
    const b = { x: 0, z: 0, yaw: 0, targetX: 10, targetZ: 0, following: false };
    for (let i = 0; i < 30; i++) stepWizardBody(b, { playerX: 0, playerZ: 0 }, 1 / 60);
    expect(Number.isFinite(b.phase)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Building collision                                                  */
/* ------------------------------------------------------------------ */

describe('wizard building collision', () => {
  const body = (over = {}) => ({
    x: 0, z: 0, yaw: 0, phase: 0, targetX: null, targetZ: null, following: false, ...over,
  });
  const box = (x, z, w = 8, d = 8) => ({ id: `b${x},${z}`, x, z, w, d, height: 12 });
  /** True if he is inside a footprint (ignoring his radius, i.e. clipping the wall). */
  const insideAny = (b, list) => list.some((o) =>
    Math.abs(b.x - o.x) < o.w / 2 && Math.abs(b.z - o.z) < o.d / 2);

  it('does not walk through a building standing in the way', () => {
    const wall = [box(0, -20)];
    const b = body({ targetX: 0, targetZ: -60 });
    for (let i = 0; i < 60 * 30; i++) {
      stepWizardBody(b, { playerX: 0, playerZ: 0, buildings: wall }, 1 / 60);
      expect(insideAny(b, wall)).toBe(false);
    }
    // Blocked on the near side; never reached the far side.
    expect(b.z).toBeGreaterThan(-20);
  });

  it('is never inside a footprint, over a long walk across a dense grid', () => {
    const city = [];
    for (let x = -40; x <= 40; x += 16) {
      for (let z = -40; z <= 40; z += 16) city.push(box(x, z, 10, 10));
    }
    const b = body({ x: -60, z: -60, targetX: 60, targetZ: 60 });
    for (let i = 0; i < 60 * 60; i++) {
      stepWizardBody(b, { playerX: 0, playerZ: 0, buildings: city }, 1 / 60);
      expect(insideAny(b, city)).toBe(false);
      expect(Number.isFinite(b.x) && Number.isFinite(b.z)).toBe(true);
    }
  });

  it('slides along a wall rather than sticking to it', () => {
    // Target is past the corner of a long wall; per-axis resolution should let
    // him keep making progress along Z even while X is blocked.
    const wall = [box(6, 0, 4, 40)];
    const b = body({ x: 0, z: -18, targetX: 20, targetZ: 18 });
    for (let i = 0; i < 60 * 20; i++) {
      stepWizardBody(b, { playerX: 0, playerZ: 0, buildings: wall }, 1 / 60);
    }
    expect(insideAny(b, wall)).toBe(false);
    expect(b.z).toBeGreaterThan(-10);   // made progress along the wall
  });

  it('gives up on an unreachable target instead of grinding forever', () => {
    const wall = [box(0, -20, 60, 8)];   // a wall far wider than he can walk around
    const b = body({ targetX: 0, targetZ: -60 });
    for (let i = 0; i < 60 * 10; i++) {
      stepWizardBody(b, { playerX: 0, playerZ: 0, buildings: wall }, 1 / 60);
    }
    expect(b.targetX).toBe(null);
    expect(b.blocked).toBe(true);
  });

  it('keeps following even when blocked — following is a standing order', () => {
    const wall = [box(0, -20, 60, 8)];
    const b = body({ following: true });
    for (let i = 0; i < 60 * 10; i++) {
      stepWizardBody(b, { playerX: 0, playerZ: -60, buildings: wall }, 1 / 60);
    }
    expect(b.following).toBe(true);
    expect(insideAny(b, wall)).toBe(false);
  });

  it('stops the gait when pressed against a wall', () => {
    const wall = [box(0, -10, 60, 8)];
    const b = body({ targetX: 0, targetZ: -60 });
    for (let i = 0; i < 60 * 5; i++) {
      stepWizardBody(b, { playerX: 0, playerZ: 0, buildings: wall }, 1 / 60);
    }
    const held = b.phase;
    for (let i = 0; i < 60; i++) {
      stepWizardBody(b, { playerX: 0, playerZ: 0, buildings: wall }, 1 / 60);
    }
    expect(b.phase).toBe(held);   // legs stop when he stops covering ground
    expect(b.moving).toBe(false);
  });

  it('walks normally when there are no buildings at all', () => {
    const b = body({ targetX: 30, targetZ: 0 });
    for (let i = 0; i < 60 * 20; i++) stepWizardBody(b, { playerX: 0, playerZ: 0 }, 1 / 60);
    expect(Math.hypot(b.x - 30, b.z)).toBeLessThanOrEqual(WIZARD_ARRIVE_EPS);
  });

  it('never throws on malformed buildings', () => {
    const junk = [null, {}, { x: NaN, z: 0, w: 4, d: 4 }, undefined];
    const b = body({ targetX: 20, targetZ: 20 });
    expect(() => {
      for (let i = 0; i < 120; i++) stepWizardBody(b, { playerX: 0, playerZ: 0, buildings: junk }, 1 / 60);
    }).not.toThrow();
    expect(Number.isFinite(b.x) && Number.isFinite(b.z)).toBe(true);
  });
});

describe('collideWizardAxis', () => {
  it('pushes out along the requested axis only', () => {
    const b = { x: 1, z: 0.5 };
    expect(collideWizardAxis(b, [{ x: 0, z: 0, w: 8, d: 8 }], 0)).toBe(true);
    expect(Math.abs(b.x)).toBeCloseTo(4 + WIZARD_RADIUS, 9);
    expect(b.z).toBe(0.5);      // untouched axis
  });

  it('leaves a body in the clear alone', () => {
    const b = { x: 50, z: 50 };
    expect(collideWizardAxis(b, [{ x: 0, z: 0, w: 8, d: 8 }], 0)).toBe(false);
    expect(b.x).toBe(50);
  });

  it('never throws on garbage', () => {
    expect(() => collideWizardAxis(null, [], 0)).not.toThrow();
    expect(() => collideWizardAxis({ x: 0, z: 0 }, null, 0)).not.toThrow();
  });
});

describe('wizard collision against the real demo city', () => {
  // Real geometry, not a synthetic grid: buildCity is what the game actually
  // renders, and layout.test.js uses the same fixture path.
  const layout = buildCity(MOCK_WORLD_INPUT.files);
  const bs = layout.buildings;
  const insideAny = (x, z) => bs.some((b) =>
    Math.abs(x - b.x) < b.w / 2 && Math.abs(z - b.z) < b.d / 2);

  it('has a city worth testing against', () => {
    expect(bs.length).toBeGreaterThan(20);
  });

  it('never ends up inside a building, walking corner to corner', () => {
    const home = pickWizardHome(layout, { x: 0, z: 0 });
    const b = {
      x: home.x, z: home.z, yaw: 0, phase: 0,
      targetX: layout.bounds.minX + 8, targetZ: layout.bounds.minZ + 8, following: false,
    };
    expect(insideAny(b.x, b.z)).toBe(false);   // and he does not START inside one
    for (let i = 0; i < 60 * 90; i++) {
      stepWizardBody(b, { playerX: 0, playerZ: 0, buildings: bs }, 1 / 60);
      if (insideAny(b.x, b.z)) {
        throw new Error(`wizard entered a building at ${b.x.toFixed(2)}, ${b.z.toFixed(2)} on frame ${i}`);
      }
    }
  });

  it('stays out of buildings while following a player who walks through them', () => {
    // The player can fly and clip corners; the wizard must not follow him in.
    const b = { x: 0, z: 0, yaw: 0, phase: 0, targetX: null, targetZ: null, following: true };
    for (let i = 0; i < 60 * 60; i++) {
      const target = bs[i % bs.length];
      stepWizardBody(b, {
        playerX: target.x, playerZ: target.z, buildings: bs,
      }, 1 / 60);
      expect(insideAny(b.x, b.z)).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Route planning                                                      */
/* ------------------------------------------------------------------ */

describe('buildPathGraph', () => {
  it('takes the symmetric closure, so a one-way link is still walkable back', () => {
    const g = buildPathGraph([
      { x: 0, z: 0, links: [1] },   // A -> B
      { x: 10, z: 0, links: [] },   // B lists nothing
    ]);
    const nbrs = (i) => Array.from({ length: g.adjIndex[i + 1] - g.adjIndex[i] },
      (_, k) => g.adjList[g.adjIndex[i] + k]);
    expect(nbrs(0)).toContain(1);
    expect(nbrs(1)).toContain(0);
  });

  it('ignores self-links and out-of-range indices instead of throwing', () => {
    expect(() => buildPathGraph([
      { x: 0, z: 0, links: [0, 99, -3, null] },
      { x: 1, z: 1, links: 'nope' },
      null,
    ])).not.toThrow();
  });

  it('handles an empty or missing graph', () => {
    expect(buildPathGraph([]).count).toBe(0);
    expect(buildPathGraph(null).count).toBe(0);
  });
});

describe('planWizardRoute', () => {
  /** A ring of 8 nodes around the origin — the only way from one side to the
   *  other is around the circle, which is exactly the "walk around it" case. */
  const ring = () => {
    const n = 8;
    const nodes = [];
    for (let i = 0; i < n; i++) {
      const th = (i / n) * Math.PI * 2;
      nodes.push({ x: Math.cos(th) * 20, z: Math.sin(th) * 20, links: [(i + 1) % n] });
    }
    return nodes;
  };
  /** A tower in the middle of the ring, so straight across is not an option. */
  const tower = [{ id: 'tower', x: 0, z: 0, w: 18, d: 18, height: 20 }];

  it('returns waypoints ending at the true destination', () => {
    const g = buildPathGraph(ring());
    const route = planWizardRoute(g, 20, 0, -20, 0, tower);
    expect(route.length).toBeGreaterThan(1);
    expect(route[route.length - 1]).toEqual({ x: -20, z: 0 });
  });

  it('routes the short way round the ring', () => {
    const g = buildPathGraph(ring());
    // Compare walked DISTANCE, not waypoint count: on a coarse 8-node ring two
    // very different journeys can use the same number of hops.
    const walked = (route, fromX, fromZ) => {
      let total = 0;
      let px = fromX;
      let pz = fromZ;
      for (const wp of route) { total += Math.hypot(wp.x - px, wp.z - pz); px = wp.x; pz = wp.z; }
      return total;
    };
    const a = planWizardRoute(g, 20, 0, 0, 20, tower);      // a quarter turn
    const b = planWizardRoute(g, 20, 0, -20, 0, tower);     // a half turn
    expect(walked(a, 20, 0)).toBeLessThan(walked(b, 20, 0));
  });

  it('walks straight when nothing is in the way, instead of hugging the pavement', () => {
    const g = buildPathGraph(ring());
    expect(planWizardRoute(g, 20, 0, -20, 0, [])).toEqual([{ x: -20, z: 0 }]);
  });

  it('sets off toward the destination, not away from it', () => {
    // Regression: seeding only the nearest node made him walk 35 units west to
    // join a pavement when the destination was 80 units north.
    const g = buildPathGraph(ring());
    const from = { x: 20, z: 0 };
    const to = { x: -20, z: 0 };
    const route = planWizardRoute(g, from.x, from.z, to.x, to.z, tower);
    const first = route[0];
    // The first leg must not be a large step in the wrong direction.
    expect(Math.hypot(first.x - from.x, first.z - from.z)).toBeLessThan(20);
  });

  it('falls back to a direct walk when there is no graph', () => {
    for (const g of [buildPathGraph([]), null, undefined]) {
      expect(planWizardRoute(g, 0, 0, 5, 6)).toEqual([{ x: 5, z: 6 }]);
    }
  });

  it('falls back to direct when the destination is unreachable in the graph', () => {
    // Two disconnected components.
    const g = buildPathGraph([
      { x: 0, z: 0, links: [1] }, { x: 5, z: 0, links: [0] },
      { x: 500, z: 500, links: [3] }, { x: 505, z: 500, links: [2] },
    ]);
    const route = planWizardRoute(g, 0, 0, 502, 500);
    expect(route[route.length - 1]).toEqual({ x: 502, z: 500 });
  });

  it('never returns NaN waypoints', () => {
    const g = buildPathGraph(ring());
    for (const route of [
      planWizardRoute(g, NaN, NaN, 0, 0),
      planWizardRoute(g, 0, 0, NaN, NaN),
      planWizardRoute(g, 20, 0, -20, 0),
    ]) {
      for (const wp of route) {
        expect(Number.isFinite(wp.x)).toBe(true);
        expect(Number.isFinite(wp.z)).toBe(true);
      }
    }
  });
});

describe('the wizard actually walks around buildings', () => {
  const layout = buildCity(MOCK_WORLD_INPUT.files);
  const bs = layout.buildings;
  const graph = buildPathGraph(layout.paths);
  const insideAny = (x, z) => bs.some((b) =>
    Math.abs(x - b.x) < b.w / 2 && Math.abs(z - b.z) < b.d / 2);

  /** Walk him along a planned route and report whether he arrived. */
  function walk(fromX, fromZ, toX, toZ, seconds = 240) {
    const b = {
      x: fromX, z: fromZ, yaw: 0, phase: 0, following: false,
      targetX: toX, targetZ: toZ,
      route: planWizardRoute(graph, fromX, fromZ, toX, toZ, bs), routeIndex: 0,
    };
    for (let i = 0; i < 60 * seconds; i++) {
      stepWizardBody(b, { playerX: 0, playerZ: 0, buildings: bs }, 1 / 60);
      if (insideAny(b.x, b.z)) throw new Error(`entered a building at ${b.x},${b.z}`);
      if (b.route === null && b.targetX === null) break;   // arrived or gave up
    }
    return { body: b, arrived: Math.hypot(b.x - toX, b.z - toZ) };
  }

  it('plans a multi-waypoint route across the real city', () => {
    const route = planWizardRoute(graph, layout.bounds.minX + 5, layout.bounds.minZ + 5,
      layout.bounds.maxX - 5, layout.bounds.maxZ - 5, bs);
    expect(route.length).toBeGreaterThan(3);
  });

  it('reaches the far corner of the city without entering a building', () => {
    const home = pickWizardHome(layout, { x: 0, z: 0 });
    const dest = { x: layout.bounds.minX + 6, z: layout.bounds.minZ + 6 };
    const { arrived } = walk(home.x, home.z, dest.x, dest.z);
    expect(arrived).toBeLessThan(WIZARD_ARRIVE_EPS + 2);
  });

  it('reaches a spot on the far side of a building it cannot walk through', () => {
    // Pick a building and stand on open ground either side of it, so the only
    // thing between the two points is the building itself.
    const clear = (x, z) => !bs.some((b) =>
      Math.abs(x - b.x) < b.w / 2 + WIZARD_RADIUS + 1 && Math.abs(z - b.z) < b.d / 2 + WIZARD_RADIUS + 1);
    const target = bs.find((b) =>
      clear(b.x + b.w / 2 + 4, b.z) && clear(b.x - b.w / 2 - 4, b.z));
    expect(target).toBeTruthy();
    const from = { x: target.x + target.w / 2 + 4, z: target.z };
    const to = { x: target.x - (target.w / 2 + 4), z: target.z };
    // The building really is in the way.
    expect(segmentHitsBuilding(from.x, from.z, to.x, to.z, bs)).toBe(true);
    const { arrived } = walk(from.x, from.z, to.x, to.z);
    expect(arrived).toBeLessThan(WIZARD_ARRIVE_EPS + 3);
  });
});

describe('route waypoints are passed through, not treated as arrivals', () => {
  it('keeps walking a route after reaching an intermediate waypoint', () => {
    // Regression: WAYPOINT_EPS is tighter than ARRIVE_EPS, which left a band
    // where the arrival branch fired on an intermediate waypoint and threw the
    // whole route away — he stopped a few frames into a 53-waypoint walk.
    const b = {
      x: 0, z: 0, yaw: 0, phase: 0, following: false,
      targetX: 60, targetZ: 0,
      route: [{ x: 20, z: 0 }, { x: 40, z: 0 }, { x: 60, z: 0 }],
      routeIndex: 0,
    };
    let sawSecondLeg = false;
    for (let i = 0; i < 60 * 60; i++) {
      stepWizardBody(b, { playerX: 0, playerZ: 0 }, 1 / 60);
      if (b.routeIndex === 1 && b.route) sawSecondLeg = true;
      if (!b.route) break;
    }
    expect(sawSecondLeg).toBe(true);                       // consumed waypoints in order
    expect(Math.hypot(b.x - 60, b.z)).toBeLessThanOrEqual(WIZARD_ARRIVE_EPS);
    expect(b.targetX).toBe(null);                          // and finished properly
  });

  it('only clears the target on the final leg', () => {
    const b = {
      x: 0, z: 0, yaw: 0, phase: 0, following: false,
      targetX: 40, targetZ: 0,
      route: [{ x: 20, z: 0 }, { x: 40, z: 0 }],
      routeIndex: 0,
    };
    // Step until the first waypoint is consumed.
    for (let i = 0; i < 60 * 20 && b.routeIndex === 0; i++) {
      stepWizardBody(b, { playerX: 0, playerZ: 0 }, 1 / 60);
    }
    expect(b.routeIndex).toBe(1);
    expect(b.targetX).toBe(40);   // still going
    expect(b.route).not.toBe(null);
  });
});

/* ------------------------------------------------------------------ */
/* locate: living things                                               */
/* ------------------------------------------------------------------ */

describe('locate finds living things, not just files', () => {
  const chase = {
    greptiles: [
      { id: 'g0', x: 100, z: 0, mode: 'idle', targetId: null },
      { id: 'g1', x: 5, z: 0, mode: 'hunting', targetId: 'issue-1' },
    ],
    bugs: [
      { id: 'b-far', x: 200, z: 0, state: 'alive', title: 'far bug', severity: 3, buildingId: 'src/a.js' },
      { id: 'b-near', x: 8, z: 0, state: 'alive', title: 'near bug', severity: 7, buildingId: 'src/b.js' },
      { id: 'b-dead', x: 1, z: 0, state: 'dead', title: 'dead bug' },
    ],
  };
  const toolsWith = (over = {}) => createWizardTools({
    getWorld: () => world(),
    getChase: () => chase,
    getPlayer: () => ({ x: 0, z: 0 }),
    control: { position: () => ({ x: 0, z: 0, following: false }) },
    ...over,
  });

  it('finds the nearest greptile — the thing that was broken', () => {
    // "find the nearest greptile" used to return "Nothing called greptile in
    // this city. Try search_paths", which is a dead end: no tool could turn the
    // word "greptile" into coordinates for move_to.
    const res = JSON.parse(toolsWith().find((t) => t.name === 'locate').run({ target: 'greptile' }));
    expect(res.kind).toBe('greptile');
    expect(res.id).toBe('g1');            // nearest, not first
    expect(res.x).toBe(5);
    expect(res.distanceFromYou).toBe(5);
  });

  it('accepts the phrasings a model actually uses', async () => {
    const locate = toolsWith().find((t) => t.name === 'locate');
    for (const phrasing of ['greptile', 'Greptile', 'the nearest greptile', 'nearest Greptile', 'greptiles']) {
      const res = JSON.parse(await locate.run({ target: phrasing }));
      expect(res.kind).toBe('greptile');
    }
  });

  it('finds the nearest live bug and ignores dead ones', () => {
    const res = JSON.parse(toolsWith().find((t) => t.name === 'locate').run({ target: 'bug' }));
    expect(res.kind).toBe('bug');
    expect(res.id).toBe('b-near');
  });

  it('finds a creature by id', () => {
    const res = JSON.parse(toolsWith().find((t) => t.name === 'locate').run({ target: 'g0' }));
    expect(res.kind).toBe('greptile');
    expect(res.x).toBe(100);
  });

  it('locates the player', () => {
    const res = JSON.parse(toolsWith({ getPlayer: () => ({ x: 12, z: -3 }) })
      .find((t) => t.name === 'locate').run({ target: 'me' }));
    expect(res.kind).toBe('player');
    expect(res.x).toBe(12);
  });

  it('measures from the wizard, since he is the one who has to walk there', () => {
    const res = JSON.parse(toolsWith({ control: { position: () => ({ x: 98, z: 0 }) } })
      .find((t) => t.name === 'locate').run({ target: 'greptile' }));
    expect(res.id).toBe('g0');   // nearest to the WIZARD at x=98, not to the player at 0
  });

  it('says so plainly when nothing is roaming', () => {
    const res = JSON.parse(createWizardTools({
      getWorld: () => world(), getChase: () => null, getPlayer: () => ({}),
    }).find((t) => t.name === 'locate').run({ target: 'greptile' }));
    expect(res.error).toMatch(/no greptiles/i);
  });

  it('still locates files and districts', () => {
    const locate = toolsWith().find((t) => t.name === 'locate');
    expect(JSON.parse(locate.run({ target: 'src/a.js' })).kind).toBe('file');
    expect(JSON.parse(locate.run({ target: 'tests' })).kind).toBe('district');
    const miss = JSON.parse(locate.run({ target: 'nope' }));
    expect(miss.error).toBeTruthy();
    expect(miss.hint).toMatch(/greptile/);
  });
});

/* ------------------------------------------------------------------ */
/* Chasing something that moves                                        */
/* ------------------------------------------------------------------ */

describe('shouldReplan', () => {
  it('re-plans when there is no plan yet', () => {
    expect(shouldReplan(null, 0, 0)).toBe(true);
    expect(shouldReplan({ x: NaN, z: 0 }, 0, 0)).toBe(true);
  });

  it('holds the route while the quarry stays near where it was aimed', () => {
    expect(shouldReplan({ x: 0, z: 0 }, 3, 3, 8)).toBe(false);
  });

  it('re-plans once the quarry has wandered past the threshold', () => {
    expect(shouldReplan({ x: 0, z: 0 }, 20, 0, 8)).toBe(true);
  });
});

describe('stepWizardBody with a live target', () => {
  const body = (over = {}) => ({
    x: 0, z: 0, yaw: 0, phase: 0, targetX: null, targetZ: null, following: false, ...over,
  });

  it('steers at where the quarry is now, not where it was', () => {
    const b = body();
    // The quarry runs east while he walks.
    for (let i = 0; i < 60 * 6; i++) {
      stepWizardBody(b, { playerX: 0, playerZ: 0, liveTarget: { x: 40 + i * 0.01, z: 0 } }, 1 / 60);
    }
    expect(b.x).toBeGreaterThan(10);      // he moved toward it
    expect(Math.abs(b.z)).toBeLessThan(1); // and did not wander off
  });

  it('a live target overrides a stale static one', () => {
    const b = body({ targetX: -100, targetZ: 0 });
    stepWizardBody(b, { playerX: 0, playerZ: 0, liveTarget: { x: 50, z: 0 } }, 1 / 60);
    expect(b.targetX).toBe(50);
    expect(b.x).toBeGreaterThan(0);        // walked east, not west
  });

  it('catches a quarry that is slower than he is', () => {
    const b = body();
    let qx = 60;
    for (let i = 0; i < 60 * 60; i++) {
      qx += 1.0 / 60;                       // 1 u/s, well under his 6.4
      stepWizardBody(b, { playerX: 0, playerZ: 0, liveTarget: { x: qx, z: 0 } }, 1 / 60);
    }
    expect(Math.abs(b.x - qx)).toBeLessThanOrEqual(WIZARD_ARRIVE_EPS);
  });

  it('ignores a malformed live target rather than steering at NaN', () => {
    const b = body({ targetX: 20, targetZ: 0 });
    stepWizardBody(b, { playerX: 0, playerZ: 0, liveTarget: { x: NaN, z: NaN } }, 1 / 60);
    expect(b.targetX).toBe(20);
    expect(Number.isFinite(b.x)).toBe(true);
  });
});

describe('chase_creature tool', () => {
  const chase = {
    greptiles: [{ id: 'g0', x: 30, z: 0, mode: 'idle' }],
    bugs: [{ id: 'b1', x: 5, z: 5, state: 'alive' }, { id: 'b-dead', x: 0, z: 0, state: 'dead' }],
  };
  const make = (control) => createWizardTools({
    getWorld: () => world(), getChase: () => chase, getPlayer: () => ({ x: 0, z: 0 }), control,
  });
  const run = async (tools, args) => JSON.parse(await tools.find((t) => t.name === 'chase_creature').run(args));

  it('starts a chase on a living creature', async () => {
    let chasing = 'unset';
    const res = await run(make({ chaseCreature: (id) => { chasing = id; } }), { id: 'g0' });
    expect(res.chasing).toBe('g0');
    expect(chasing).toBe('g0');
    expect(res.nowAt).toEqual({ x: 30, z: 0 });
  });

  it('stops when given an empty id', async () => {
    let chasing = 'unset';
    const res = await run(make({ chaseCreature: (id) => { chasing = id; } }), { id: '' });
    expect(res.chasing).toBe(null);
    expect(chasing).toBe(null);
  });

  it('refuses an unknown or dead creature without starting a chase', async () => {
    let called = false;
    const tools = make({ chaseCreature: () => { called = true; } });
    expect((await run(tools, { id: 'nope' })).error).toMatch(/No living creature/);
    expect((await run(tools, { id: 'b-dead' })).error).toMatch(/No living creature/);
    expect(called).toBe(false);
  });

  it('says so when he has no body to move', async () => {
    expect((await run(make({}), { id: 'g0' })).error).toMatch(/cannot move/i);
  });
});

/* ------------------------------------------------------------------ */
/* Aiming at the wizard                                                */
/* ------------------------------------------------------------------ */

describe('isAimedAtWizard', () => {
  const wiz = { x: 0, z: -10 };          // 10 units in front of a camera at origin
  /** Camera at origin looking down -Z (the world's default heading), then yawed. */
  const cam = (yawDeg = 0, pitchDeg = 0, at = { x: 0, y: 2, z: 0 }) => {
    const y = (yawDeg * Math.PI) / 180;
    const p = (pitchDeg * Math.PI) / 180;
    return {
      ...at,
      dirX: Math.sin(y) * Math.cos(p),
      dirY: Math.sin(p),
      dirZ: -Math.cos(y) * Math.cos(p),
    };
  };

  it('is true when the crosshair is on him', () => {
    expect(isAimedAtWizard(cam(0), wiz)).toBe(true);
  });

  it('is FALSE when he is in range but you are facing away — the actual bug', () => {
    // Standing next to him with your back turned used to still show
    // "press R to speak with the wizard".
    expect(isAimedAtWizard(cam(180), wiz)).toBe(false);
    expect(isAimedAtWizard(cam(90), wiz)).toBe(false);
  });

  it('is false when looking past him to one side', () => {
    expect(isAimedAtWizard(cam(45), wiz)).toBe(false);
    expect(isAimedAtWizard(cam(-45), wiz)).toBe(false);
  });

  it('forgives a small aiming error, since he is a large target', () => {
    expect(isAimedAtWizard(cam(6), wiz)).toBe(true);
    expect(isAimedAtWizard(cam(-6), wiz)).toBe(true);
  });

  it('counts his whole body, not just his midriff', () => {
    // Looking up at his hat and down at his feet both count: he is over 7 units
    // tall, so a centre-only test would miss both ends at close range.
    const close = { x: 0, z: -4 };
    expect(isAimedAtWizard(cam(0, 35, { x: 0, y: 2, z: 0 }), close)).toBe(true);   // hat
    expect(isAimedAtWizard(cam(0, -18, { x: 0, y: 2, z: 0 }), close)).toBe(true);  // feet
  });

  it('still rejects looking well above or below him', () => {
    expect(isAimedAtWizard(cam(0, 80, { x: 0, y: 2, z: 0 }), wiz)).toBe(false);
    expect(isAimedAtWizard(cam(0, -70, { x: 0, y: 2, z: 0 }), wiz)).toBe(false);
  });

  it('respects the distance limit even when aimed dead on', () => {
    expect(isAimedAtWizard(cam(0), { x: 0, z: -13 }, { maxDistance: 14 })).toBe(true);
    expect(isAimedAtWizard(cam(0), { x: 0, z: -30 }, { maxDistance: 14 })).toBe(false);
  });

  it('gets more forgiving in angle as he fills more of the screen', () => {
    // The same aiming error should hit up close (he fills the view) and miss
    // far away (he is a speck). 20 degrees is comfortably either side of the
    // boundary at both ranges, rather than sitting on it.
    expect(isAimedAtWizard(cam(20), { x: 0, z: -2.5 })).toBe(true);
    expect(isAimedAtWizard(cam(20), { x: 0, z: -13 })).toBe(false);
  });

  it('never throws on degenerate input', () => {
    expect(isAimedAtWizard(null, wiz)).toBe(false);
    expect(isAimedAtWizard(cam(0), null)).toBe(false);
    expect(isAimedAtWizard({ x: NaN, y: NaN, z: NaN }, wiz)).toBe(false);
    expect(isAimedAtWizard(cam(0), { x: NaN, z: NaN })).toBe(false);
  });
});
