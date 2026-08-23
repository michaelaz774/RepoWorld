/**
 * Quests & NPCs — the teaching layer of Repo World.
 *
 * Pure logic, no three.js imports, fully unit-testable. Everything here is
 * generated FROM the real repo data (`WorldData`, see src/lib/types.js) —
 * nothing is hardcoded to a specific repo, and nothing uses `Math.random()`.
 * All "randomness" (name picks, jitter, angles) comes from an FNV-1a hash of
 * a stable string (a path, a district name, a role key), so the same world
 * always produces the same quests and the same NPCs in the same spots.
 *
 * Quest archetypes (see generateQuests):
 *   entry        — find the repo's entry-point file
 *   districts    — visit N different top-level directories
 *   biggest      — visit the single largest file in the repo
 *   exterminator — deploy Greptile on N bugs (any hazards)
 *   boss         — defeat the single highest-severity hazard
 *   imports      — visit a file, then a file it imports (uses world.edges)
 *   locals       — talk to N NPCs
 *
 * NPC roster (see generateNpcs): a Guide (points at the entry quest), one
 * NPC per notable district (a Mechanic in the buggiest one, a Librarian near
 * docs, a Foreman where the biggest file lives, plain Residents elsewhere),
 * each with dialogue lines built from that district's real stats.
 */

/* ------------------------------------------------------------------ */
/* Deterministic hashing (FNV-1a) — no Math.random anywhere            */
/* ------------------------------------------------------------------ */

function fnv1a(str) {
  let h = 2166136261;
  const s = String(str == null ? '' : str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic [0, 1) from any string. */
function hash01(str) {
  return (fnv1a(str) % 1000003) / 1000003;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function clampSev(s) {
  const n = Number(s);
  return Number.isFinite(n) ? clamp(n, 1, 10) : 1;
}

function safeArr(a) {
  return Array.isArray(a) ? a : [];
}

/* ------------------------------------------------------------------ */
/* World accessors                                                     */
/* ------------------------------------------------------------------ */

function buildingsOf(world) {
  return safeArr(world && world.layout && world.layout.buildings);
}
function districtsOf(world) {
  return safeArr(world && world.layout && world.layout.districts);
}
function plotsOf(world) {
  return safeArr(world && world.layout && world.layout.plots);
}
function edgesOf(world) {
  return safeArr(world && world.edges);
}
function hazardsOf(world) {
  return safeArr(world && world.hazards);
}

function byId(list) {
  const m = new Map();
  for (const item of list) {
    if (item && item.id != null) m.set(item.id, item);
  }
  return m;
}

function repoLabelOf(world) {
  const r = world && world.repo;
  return r && r.owner && r.repo ? `${r.owner}/${r.repo}` : 'this repo';
}

/* ------------------------------------------------------------------ */
/* Data-driven pure helpers (each references only real world data)     */
/* ------------------------------------------------------------------ */

const ENTRY_BASENAMES = new Set([
  'index', 'main', 'app', 'server', 'cli', 'bootstrap', 'entry',
]);

/** Best-guess entry-point building: a file named index/main/app/etc, biased
 * toward shallow directories (repo root, then `src`). Falls back to the
 * shallowest, lexicographically-first file so it never returns nothing. */
function findEntryBuilding(buildings) {
  let best = null;
  let bestScore = -Infinity;
  for (const b of buildings) {
    if (!b || !b.path) continue;
    const base = String(b.name || '').replace(/\.[^./]+$/, '').toLowerCase();
    if (!ENTRY_BASENAMES.has(base)) continue;
    const dir = b.dir || '';
    const depth = dir ? dir.split('/').length : 0;
    const dirBonus = dir === '' || dir === 'src' ? 3 : /^(src\/)?(bin|cmd)/.test(dir) ? 1 : 0;
    const score = dirBonus * 100 - depth * 10 - String(b.path).length * 0.001;
    if (score > bestScore || (score === bestScore && best && String(b.path).localeCompare(best.path) < 0)) {
      bestScore = score;
      best = b;
    }
  }
  if (best) return best;
  const sorted = buildings
    .filter((b) => b && b.path)
    .slice()
    .sort((a, b) => {
      const da = (a.dir || '') ? a.dir.split('/').length : 0;
      const db = (b.dir || '') ? b.dir.split('/').length : 0;
      if (da !== db) return da - db;
      return String(a.path).localeCompare(String(b.path));
    });
  return sorted[0] || null;
}

/** Largest file by byte size (tie-break by path for determinism). */
function findBiggestBuilding(buildings) {
  let best = null;
  for (const b of buildings) {
    if (!b || !b.path) continue;
    const size = Number(b.size) || 0;
    if (!best || size > (Number(best.size) || 0) ||
        (size === (Number(best.size) || 0) && String(b.path).localeCompare(best.path) < 0)) {
      best = b;
    }
  }
  return best;
}

/** Highest-severity hazard in the repo (tie-break by id). */
function findBossHazard(hazards) {
  let best = null;
  for (const h of hazards) {
    if (!h || h.id == null) continue;
    const sev = clampSev(h.severity);
    const bestSev = best ? clampSev(best.severity) : -Infinity;
    if (sev > bestSev || (sev === bestSev && best && String(h.id).localeCompare(best.id) < 0)) {
      best = h;
    }
  }
  return best;
}

/** Strongest real import edge between two buildings that both exist. */
function findFollowEdge(edges, buildingsById) {
  const valid = edges.filter(
    (e) => e && e.from && e.to && e.from !== e.to && buildingsById.has(e.from) && buildingsById.has(e.to)
  );
  if (!valid.length) return null;
  valid.sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0) ||
    String(a.from + '>' + a.to).localeCompare(b.from + '>' + b.to));
  return valid[0];
}

function districtNames(districts) {
  return districts.map((d) => d && d.name).filter((n) => n != null);
}

/** Per-district aggregate stats used both to pick roles and to write dialogue. */
function computeDistrictStats(world) {
  const buildings = buildingsOf(world);
  const hazards = hazardsOf(world);
  const buildingsById = byId(buildings);
  const byDistrict = new Map();
  for (const b of buildings) {
    if (!b) continue;
    const name = b.district == null ? '/' : b.district;
    let s = byDistrict.get(name);
    if (!s) {
      s = { name, count: 0, langCounts: new Map(), sevTotal: 0, biggest: null };
      byDistrict.set(name, s);
    }
    s.count += 1;
    s.langCounts.set(b.lang || 'Other', (s.langCounts.get(b.lang || 'Other') || 0) + 1);
    if (!s.biggest || (Number(b.size) || 0) > (Number(s.biggest.size) || 0)) s.biggest = b;
  }
  for (const h of hazards) {
    if (!h || h.path == null) continue;
    const b = buildingsById.get(h.path);
    if (!b) continue;
    const name = b.district == null ? '/' : b.district;
    const s = byDistrict.get(name);
    if (s) s.sevTotal += clampSev(h.severity);
  }
  return byDistrict;
}

function dominantLang(langCounts) {
  let best = 'Other';
  let bestCount = -1;
  for (const [lang, c] of langCounts) {
    if (c > bestCount || (c === bestCount && lang < best)) {
      best = lang;
      bestCount = c;
    }
  }
  return best;
}

function fmtBytes(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  return v.toLocaleString('en-US');
}

/* ------------------------------------------------------------------ */
/* generateQuests                                                      */
/* ------------------------------------------------------------------ */

/**
 * @param {import('./types.js').WorldData} world
 * @param {Object} [opts]
 * @returns {Object[]} Quest[] deterministic, ordered easiest-first
 */
export function generateQuests(world, opts = {}) {
  void opts; // reserved for future tuning; generation is fully data-driven today
  const buildings = buildingsOf(world);
  if (buildings.length === 0) return [];

  const districts = districtsOf(world);
  const edges = edgesOf(world);
  const hazards = hazardsOf(world);
  const buildingsById = byId(buildings);
  const repoLabel = repoLabelOf(world);
  const quests = [];

  // 1. Find the entry point.
  const entry = findEntryBuilding(buildings);
  if (entry) {
    quests.push({
      id: 'entry',
      archetype: 'entry',
      title: 'Find the Entry Point',
      description: `Every town has a front door. For ${repoLabel} it's \`${entry.path}\` — walk up and step inside.`,
      hint: `Head to ${entry.path}.`,
      difficulty: 1,
      objective: { type: 'visit', target: entry.path },
    });
  }

  // 2. Tour the districts.
  const dNames = districtNames(districts);
  if (dNames.length > 0) {
    const target = Math.min(3, dNames.length);
    quests.push({
      id: 'districts',
      archetype: 'districts',
      title: 'Tour the Districts',
      description: `${repoLabel} is split into ${dNames.length} neighborhood${dNames.length === 1 ? '' : 's'} — one per top-level folder. Walk into ${target} of them and see what each one is for.`,
      hint: `Visit ${target} different district${target === 1 ? '' : 's'}.`,
      difficulty: 1,
      objective: { type: 'districtCount', target, pool: dNames.slice().sort() },
    });
  }

  // 3. The biggest building in town.
  const biggest = findBiggestBuilding(buildings);
  if (biggest && (!entry || biggest.path !== entry.path)) {
    const label = biggest.district === '/' ? 'the town square' : `the ${biggest.district} district`;
    quests.push({
      id: 'biggest',
      archetype: 'biggest',
      title: 'The Biggest Building in Town',
      description: `\`${biggest.path}\` towers over ${label} at ${fmtBytes(biggest.size)} bytes. Go find out what it does.`,
      hint: `Visit ${biggest.path}, the tallest building around.`,
      difficulty: 2,
      objective: { type: 'visit', target: biggest.path },
    });
  }

  // 4. Exterminator + 5. Boss fight (both need hazards to exist).
  if (hazards.length > 0) {
    const killTarget = Math.min(3, hazards.length);
    quests.push({
      id: 'exterminator',
      archetype: 'exterminator',
      title: 'Exterminator',
      description: `${hazards.length} bug${hazards.length === 1 ? ' is' : 's are'} crawling the streets. Deploy Greptile on ${killTarget} of them.`,
      hint: `Deploy Greptile on ${killTarget} bug${killTarget === 1 ? '' : 's'}.`,
      difficulty: 2,
      objective: { type: 'killCount', target: killTarget },
    });

    const boss = findBossHazard(hazards);
    if (boss) {
      quests.push({
        id: 'boss',
        archetype: 'boss',
        title: 'Boss Fight',
        description: `The worst of them all: "${boss.title || boss.id}" — severity ${clampSev(boss.severity)}/10. Track it down and finish it.`,
        hint: `Find and defeat "${boss.title || boss.id}".`,
        difficulty: 4,
        objective: { type: 'killTarget', target: boss.id, severity: clampSev(boss.severity) },
      });
    }
  }

  // 6. Follow the imports.
  const edge = findFollowEdge(edges, buildingsById);
  if (edge) {
    quests.push({
      id: 'imports',
      archetype: 'imports',
      title: 'Follow the Imports',
      description: `\`${edge.from}\` reaches into \`${edge.to}\`. Visit both and see how code here leans on code there.`,
      hint: `Visit ${edge.from}, then ${edge.to}.`,
      difficulty: 3,
      objective: { type: 'visitSet', targets: [edge.from, edge.to] },
    });
  }

  // 7. Meet the locals — target count comes from the same roster generateNpcs will build.
  const roster = planNpcRoster(world, quests);
  if (roster.length > 0) {
    const target = Math.min(3, roster.length);
    quests.push({
      id: 'locals',
      archetype: 'locals',
      title: 'Meet the Locals',
      description: `${roster.length} local${roster.length === 1 ? '' : 's'} live in this town and know it better than anyone. Talk to ${target} of them.`,
      hint: `Talk to ${target} NPC${target === 1 ? '' : 's'}.`,
      difficulty: 1,
      objective: { type: 'talkCount', target },
    });
  }

  quests.sort((a, b) => (a.difficulty - b.difficulty) || String(a.id).localeCompare(String(b.id)));
  return quests;
}

/* ------------------------------------------------------------------ */
/* Quest state / progress                                              */
/* ------------------------------------------------------------------ */

function initProgress(quest) {
  const o = (quest && quest.objective) || {};
  switch (o.type) {
    case 'visitSet': return { hit: [], done: false };
    case 'districtCount': return { seen: [], done: false };
    case 'killCount': return { seen: [], done: false };
    case 'talkCount': return { seen: [], done: false };
    case 'visit':
    case 'killTarget':
    default:
      return { done: false };
  }
}

/**
 * @param {Object[]} quests Quest[] from generateQuests
 * @returns {Object} initial quest progress state
 */
export function createQuestState(quests) {
  const list = safeArr(quests).filter((q) => q && q.id != null);
  const progress = {};
  for (const q of list) progress[q.id] = initProgress(q);
  return { quests: list, progress };
}

function applyEvent(quest, progress, event) {
  const o = (quest && quest.objective) || {};
  switch (o.type) {
    case 'visit': {
      if (progress.done || event.type !== 'visit') return progress;
      if (event.path != null && event.path === o.target) return { done: true };
      return progress;
    }
    case 'visitSet': {
      if (progress.done || event.type !== 'visit') return progress;
      const targets = safeArr(o.targets);
      if (event.path == null || !targets.includes(event.path) || progress.hit.includes(event.path)) return progress;
      const hit = progress.hit.concat(event.path);
      return { hit, done: targets.every((t) => hit.includes(t)) };
    }
    case 'districtCount': {
      if (progress.done || event.type !== 'district') return progress;
      const pool = safeArr(o.pool);
      if (event.name == null || !pool.includes(event.name) || progress.seen.includes(event.name)) return progress;
      const seen = progress.seen.concat(event.name);
      return { seen, done: seen.length >= (o.target || 0) };
    }
    case 'killCount': {
      if (progress.done || event.type !== 'bugKilled') return progress;
      if (event.bugId == null || progress.seen.includes(event.bugId)) return progress;
      const seen = progress.seen.concat(event.bugId);
      return { seen, done: seen.length >= (o.target || 0) };
    }
    case 'killTarget': {
      if (progress.done || event.type !== 'bugKilled') return progress;
      if (event.bugId == null || event.bugId !== o.target) return progress;
      return { done: true };
    }
    case 'talkCount': {
      if (progress.done || event.type !== 'talk') return progress;
      if (event.npcId == null || progress.seen.includes(event.npcId)) return progress;
      const seen = progress.seen.concat(event.npcId);
      return { seen, done: seen.length >= (o.target || 0) };
    }
    default:
      return progress;
  }
}

/**
 * Advance quest progress for one event. Never throws on unknown event types,
 * is idempotent for repeated identical events (returns the SAME state
 * reference when nothing actually changed), and never mutates its input.
 * @param {Object} state from createQuestState / a prior updateQuestProgress
 * @param {{type:string,[key:string]:*}} event
 * @returns {Object} next state (or the same `state` if nothing changed)
 */
export function updateQuestProgress(state, event) {
  const safeState = state && Array.isArray(state.quests) ? state : { quests: [], progress: {} };
  if (!event || typeof event.type !== 'string') return safeState;
  let changed = false;
  const nextProgress = { ...safeState.progress };
  for (const q of safeState.quests) {
    if (!q || q.id == null) continue;
    const cur = nextProgress[q.id] || initProgress(q);
    let updated;
    try {
      updated = applyEvent(q, cur, event);
    } catch {
      updated = cur;
    }
    if (updated !== cur) {
      nextProgress[q.id] = updated;
      changed = true;
    }
  }
  if (!changed) return safeState;
  return { quests: safeState.quests, progress: nextProgress };
}

function progressSummary(quest, p) {
  const o = (quest && quest.objective) || {};
  switch (o.type) {
    case 'visitSet': return { current: (p.hit || []).length, target: safeArr(o.targets).length, done: !!p.done };
    case 'districtCount': return { current: (p.seen || []).length, target: o.target || 0, done: !!p.done };
    case 'killCount': return { current: (p.seen || []).length, target: o.target || 0, done: !!p.done };
    case 'talkCount': return { current: (p.seen || []).length, target: o.target || 0, done: !!p.done };
    case 'visit':
    case 'killTarget':
    default:
      return { current: p.done ? 1 : 0, target: 1, done: !!p.done };
  }
}

/**
 * @param {Object} state
 * @returns {Object[]} quests not yet completed, each with a `.progress` summary
 */
export function activeQuests(state) {
  if (!state || !Array.isArray(state.quests)) return [];
  const out = [];
  for (const q of state.quests) {
    if (!q || q.id == null) continue;
    const p = (state.progress && state.progress[q.id]) || initProgress(q);
    if (p.done) continue;
    out.push({ ...q, progress: progressSummary(q, p) });
  }
  return out;
}

/**
 * @param {Object} state
 * @returns {{total:number, completed:number, active:number, nextHint:string|null}}
 */
export function questSummary(state) {
  const quests = state && Array.isArray(state.quests) ? state.quests : [];
  let completed = 0;
  let nextHint = null;
  for (const q of quests) {
    if (!q || q.id == null) continue;
    const p = (state.progress && state.progress[q.id]) || initProgress(q);
    if (p.done) completed += 1;
    else if (nextHint == null) nextHint = q.hint || q.title || null;
  }
  return { total: quests.length, completed, active: quests.length - completed, nextHint };
}

/* ------------------------------------------------------------------ */
/* NPC roster planning (shared by generateQuests' "locals" count and   */
/* generateNpcs' actual placement, so the two never disagree)          */
/* ------------------------------------------------------------------ */

const MAX_DISTRICT_NPCS = 8;

function questIdByArchetype(quests, archetype) {
  const q = safeArr(quests).find((qq) => qq && qq.archetype === archetype);
  return q ? q.id : null;
}

/** Deterministic roster of {role, district, questId, stats, seedKey}. Pure
 * data planning only — no positions, no dialogue text (see generateNpcs). */
function planNpcRoster(world, quests) {
  const buildings = buildingsOf(world);
  const districts = districtsOf(world);
  if (buildings.length === 0 || districts.length === 0) return [];

  const stats = computeDistrictStats(world);
  const biggest = findBiggestBuilding(buildings);
  const entry = findEntryBuilding(buildings);

  let buggiest = null;
  for (const s of stats.values()) {
    if (s.sevTotal <= 0) continue;
    if (!buggiest || s.sevTotal > buggiest.sevTotal || (s.sevTotal === buggiest.sevTotal && s.name < buggiest.name)) {
      buggiest = s;
    }
  }
  const foremanDistrict = biggest ? (biggest.district == null ? '/' : biggest.district) : null;

  const ordered = districts
    .slice()
    .filter((d) => d && d.name != null)
    .sort((a, b) => {
      const sa = stats.get(a.name) || { count: 0 };
      const sb = stats.get(b.name) || { count: 0 };
      return (sb.count - sa.count) || String(a.name).localeCompare(String(b.name));
    });
  const chosen = ordered.slice(0, MAX_DISTRICT_NPCS);

  const entryQid = questIdByArchetype(quests, 'entry');
  const bossQid = questIdByArchetype(quests, 'boss');
  const extermQid = questIdByArchetype(quests, 'exterminator');
  const biggestQid = questIdByArchetype(quests, 'biggest');

  const roster = [];
  const guideDistrict = entry
    ? (entry.district == null ? '/' : entry.district)
    : (chosen[0] ? chosen[0].name : ordered[0].name);
  roster.push({
    role: 'guide',
    district: guideDistrict,
    questId: entryQid,
    seedKey: 'npc-guide',
    stats: stats.get(guideDistrict) || { count: 0, langCounts: new Map(), sevTotal: 0, biggest: null },
  });

  for (const d of chosen) {
    const s = stats.get(d.name) || { count: 0, langCounts: new Map(), sevTotal: 0, biggest: null };
    let role = 'resident';
    let questId = null;
    if (buggiest && d.name === buggiest.name) {
      role = 'mechanic';
      questId = bossQid || extermQid;
    } else if (foremanDistrict != null && d.name === foremanDistrict) {
      role = 'foreman';
      questId = biggestQid;
    } else if (/doc/i.test(String(d.name)) || dominantLang(s.langCounts) === 'Markdown') {
      role = 'librarian';
    }
    roster.push({ role, district: d.name, questId, seedKey: 'npc-' + d.name, stats: s });
  }
  return roster;
}

/* ------------------------------------------------------------------ */
/* NPC placement + dialogue                                            */
/* ------------------------------------------------------------------ */

function districtByName(districts, name) {
  return districts.find((d) => d && d.name === name) || null;
}

function plotsInDistrict(plots, name) {
  return plots.filter((p) => p && p.district === name);
}

/** True if (x,z) overlaps any building footprint, with a small safety buffer. */
function insideAnyBuilding(x, z, buildings, buf = 0.6) {
  for (const b of buildings) {
    if (!b) continue;
    const hw = (Number(b.w) || 1) / 2 + buf;
    const hd = (Number(b.d) || 1) / 2 + buf;
    if (Math.abs(x - (Number(b.x) || 0)) < hw && Math.abs(z - (Number(b.z) || 0)) < hd) return true;
  }
  return false;
}

/** Deterministic, collision-checked NPC spot: prefer a plot in the district
 * (parks/plazas are guaranteed building-free), else search inside the
 * district rect, else fall back to the district center as a last resort. */
function placePosition(seedKey, district, plots, buildings) {
  if (!district) return { x: 0, z: 0 };
  const anchors = [];
  const dplots = plotsInDistrict(plots, district.name);
  if (dplots.length > 0) {
    const idx = Math.floor(hash01(seedKey + '-plot') * dplots.length) % dplots.length;
    anchors.push(dplots[idx]);
  }
  anchors.push(district);

  for (const a of anchors) {
    const halfW = Math.max((Number(a.w) || 4) / 2 - 0.8, 0.4);
    const halfD = Math.max((Number(a.d) || 4) / 2 - 0.8, 0.4);
    for (let attempt = 0; attempt < 10; attempt++) {
      const ang = hash01(seedKey + '-a' + attempt) * Math.PI * 2;
      const rad = hash01(seedKey + '-r' + attempt);
      const x = (Number(a.x) || 0) + Math.cos(ang) * halfW * rad;
      const z = (Number(a.z) || 0) + Math.sin(ang) * halfD * rad;
      if (!insideAnyBuilding(x, z, buildings)) return { x, z };
    }
  }
  return { x: Number(district.x) || 0, z: Number(district.z) || 0 };
}

const FIRST_NAMES = [
  'Ada', 'Rex', 'Vera', 'Sam', 'Milo', 'Nia', 'Theo', 'Juno',
  'Otto', 'Pixel', 'Byte', 'Nova', 'Kip', 'Wren', 'Dot', 'Cass',
];

function pickName(seedKey) {
  const idx = Math.floor(hash01(seedKey + '-name') * FIRST_NAMES.length) % FIRST_NAMES.length;
  return FIRST_NAMES[idx];
}

function roleTitle(role) {
  switch (role) {
    case 'guide': return 'Guide';
    case 'mechanic': return 'Mechanic';
    case 'librarian': return 'Librarian';
    case 'foreman': return 'Foreman';
    default: return 'Resident';
  }
}

const OUTFIT_COLORS = {
  guide: '#3b6ea5',
  mechanic: '#b5541f',
  librarian: '#6a4fa0',
  foreman: '#c9962a',
  resident: '#4c8c5b',
};

function outfitColorFor(role) {
  return OUTFIT_COLORS[role] || OUTFIT_COLORS.resident;
}

function districtLabel(name) {
  return name === '/' ? 'the town square' : `the ${name} district`;
}

function guideLines(world, entry) {
  const stats = (world && world.stats) || {};
  const lines = [`Welcome to ${repoLabelOf(world)}! This whole town was built out of its code.`];
  if (world && world.summary) lines.push(String(world.summary).slice(0, 220));
  lines.push(
    `${stats.files || 0} buildings, ${stats.issues || 0} bug${stats.issues === 1 ? '' : 's'}, ` +
    `${stats.prs || 0} work crew${stats.prs === 1 ? '' : 's'}, and ${stats.risks || 0} risky spot${stats.risks === 1 ? '' : 's'} to watch for.`
  );
  if (entry) lines.push(`New here? Start at ${entry.path} — that's the front door of the whole place.`);
  return lines;
}

function residentLines(districtName, s) {
  const lang = dominantLang(s.langCounts);
  const lines = [
    `I live in ${districtLabel(districtName)}. ${s.count} building${s.count === 1 ? '' : 's'} here, mostly ${lang}.`,
  ];
  if (s.biggest) {
    lines.push(`The tallest place around here is ${s.biggest.name} — ${fmtBytes(s.biggest.size)} bytes.`);
  }
  return lines;
}

function mechanicLines(districtName, s, boss) {
  const lines = [
    `${districtLabel(districtName)[0].toUpperCase()}${districtLabel(districtName).slice(1)} gets the most bug calls in town — ${Math.round(s.sevTotal)} trouble points and counting.`,
  ];
  if (boss) {
    lines.push(`Watch out for "${boss.title || boss.id}" — worst one I've seen, severity ${clampSev(boss.severity)}/10. Deploy Greptile if you're brave enough.`);
  } else {
    lines.push('Deploy Greptile on the bugs crawling around here before they multiply.');
  }
  return lines;
}

function librarianLines(districtName, s) {
  return [
    `Welcome to the archive. ${s.count} file${s.count === 1 ? '' : 's'} of notes live in ${districtLabel(districtName)}.`,
    'Reading the docs first will save you a lot of guesswork in the rest of the town.',
  ];
}

function foremanLines(biggest) {
  return [
    `See that big one? ${biggest.name} — ${fmtBytes(biggest.size)} bytes, ${Math.round(Number(biggest.height) || 0)} stories tall.`,
    'Whoever wrote that file did a lot in one place. Might be due for a split someday.',
  ];
}

/**
 * @param {import('./types.js').WorldData} world
 * @param {Object[]} quests Quest[] from generateQuests (for questId wiring)
 * @param {Object} [opts]
 * @returns {Object[]} Npc[] — {id, x, z, name, role, questId, lines, district, outfitColor}
 */
export function generateNpcs(world, quests = [], opts = {}) {
  void opts;
  const buildings = buildingsOf(world);
  const districts = districtsOf(world);
  if (buildings.length === 0 || districts.length === 0) return [];

  const plots = plotsOf(world);
  const hazards = hazardsOf(world);
  const roster = planNpcRoster(world, safeArr(quests));
  const entry = findEntryBuilding(buildings);
  const biggest = findBiggestBuilding(buildings);
  const boss = findBossHazard(hazards);

  const npcs = [];
  const usedIds = new Set();
  for (const r of roster) {
    const district = districtByName(districts, r.district) || districts[0];
    const pos = placePosition(r.seedKey, district, plots, buildings);
    const name = pickName(r.seedKey);
    const s = r.stats || { count: 0, langCounts: new Map(), sevTotal: 0, biggest: null };

    let lines;
    switch (r.role) {
      case 'guide': lines = guideLines(world, entry); break;
      case 'mechanic': lines = mechanicLines(r.district, s, boss); break;
      case 'librarian': lines = librarianLines(r.district, s); break;
      case 'foreman': lines = biggest ? foremanLines(biggest) : residentLines(r.district, s); break;
      default: lines = residentLines(r.district, s); break;
    }
    if (!lines || lines.length === 0) lines = ['Hi — I live around here.'];

    let id = r.seedKey;
    let n = 1;
    while (usedIds.has(id)) id = r.seedKey + '-' + (++n);
    usedIds.add(id);

    npcs.push({
      id,
      x: pos.x,
      z: pos.z,
      name,
      role: roleTitle(r.role),
      questId: r.questId || null,
      lines,
      district: r.district,
      outfitColor: outfitColorFor(r.role),
    });
  }
  return npcs;
}
