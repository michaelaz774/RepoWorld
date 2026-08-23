/**
 * Chase — the Bugs vs. Greptile-pack simulation. Pure logic, no three.js imports.
 *
 * FICTION: `issue`/`risk` hazards are bugs nesting near the building they affect.
 * A small PACK of Greptiles roams the city independently (street-level, ~2x
 * human height). The PLAYER deploys one of them onto a specific bug (see
 * `assignTarget`); catching it = that Greptile opening a PR that fixes it.
 * `pr` hazards aren't used to pick targets — they only enrich the kill event
 * with a PR number for the "PR #123 — fixed" callout, when one happens to
 * target the same building as the bug that was caught.
 *
 * PACK: `state.greptiles` is the array of creatures (see `PACK_SIZE`).
 * `state.greptile` is kept as a live getter alias for `state.greptiles[0]`
 * for any consumer that only knows about the old single-creature shape.
 *
 * GREPTILE LIFECYCLE (per creature)
 *   'idle'  — no assignment: slow deterministic roam around the city (each
 *             creature roams independently, seeded by its own id). Entered
 *             at creation and again after every kill (no auto-retarget).
 *   'hunt'  — beelines for its targetId's bug.
 *   'lunge' — short, fast final approach once within CAPTURE_RADIUS.
 *   'chomp' — the bite: the target is caught partway through, then the mode
 *             resets to 'idle' with no target (the player picks the next one).
 *
 * DISPATCH: `assignTarget(state, bugId)` sends a creature after a specific
 * bug — it picks the NEAREST IDLE creature to that bug. If every creature is
 * already busy hunting something else, it preempts whichever creature is
 * nearest overall, so a player's press is never a no-op. If some creature is
 * already hunting that exact bug, this is a no-op (doesn't double-dispatch).
 * This is also what `stepChase` calls internally when it sees a fresh
 * `playerState.deployRequested` + `playerState.targetedBug` (see below), so
 * the targeting/input agent doesn't need to import this module directly.
 *
 * BUG LIFECYCLE: 'alive' (wanders near its anchor) -> 'dying' (brief death-beat
 * window, DEATH_DURATION seconds, for the visual pop) -> 'dead' (terminal). Kills
 * are permanent now — the issue is fixed, it does not come back. No respawn.
 * With everything dead the sim keeps running fine: every Greptile just
 * idles/roams forever, bugsAlive stays 0, nothing NaNs or throws.
 *
 * KILL EVENTS: whenever a chomp actually lands, stepChase appends a plain object
 * to `state.events` (`{type:'kill', bugId, buildingId, kind, severity, title,
 * number, prNumber, greptileId, x, z, time}`) so a UI can pop the review panel
 * at exactly the right tick without diffing bug arrays frame to frame. Use
 * `drainEvents(state)` to read + clear it (returns a shared frozen empty array
 * when there's nothing new, so the common no-event frame allocates nothing).
 *
 * DETERMINISM: no Math.random anywhere. Every bug/creature gets a uint32 seed
 * from an FNV-1a hash of a stable string (hazard id / pack index); wander/roam
 * decisions advance that seed with a mulberry32-style mix, so the whole
 * simulation is a pure function of the (dt) sequence fed to stepChase (plus
 * whatever assignTarget calls happen).
 *
 * PLAYERSTATE COUPLING: stepChase reads two fields from the shared, mutable
 * `playerState` singleton (src/lib/playerState.js) so a separate
 * targeting/input component can drive a deploy without calling into this
 * module directly: `playerState.targetedBug` (bug id under the crosshair) and
 * `playerState.deployRequested` (true for one frame on a valid deploy press).
 * stepChase consumes deployRequested (resets it to false) and, if a
 * targetedBug is set, calls assignTarget with it. `playerState.uiFocused`
 * (true while a review/dialogue panel has focus) softens — doesn't freeze —
 * the sim's pace, so it doesn't look frozen behind a panel but also doesn't
 * race ahead while the player isn't looking.
 *
 * PERFORMANCE: stepChase mutates bug/greptile fields in place; the only
 * allocation in the whole module is (a) the rare kill-event object, pushed only
 * on the tick a catch actually lands, and (b) the small return objects from
 * chaseStats()/drainEvents(), both meant for HUD/debug polling, not the render
 * hot path.
 */
import { playerState } from './playerState.js';

const DEFAULT_MAX_BUGS = 60;
const PACK_SIZE = 4;             // number of Greptiles roaming the city at once
const BUG_ANCHOR_MARGIN = 1.3;   // clearance from the building footprint edge
const BUG_SPEED = 3.0;           // u/s during a dash burst
const GREPTILE_SPEED = 14;       // u/s while hunting
const GREPTILE_ROAM_SPEED = 3.5; // u/s while idling
const ROAM_STEP_MIN = 6;
const ROAM_STEP_MAX = 16;
const CAPTURE_RADIUS = 3;        // hunt -> lunge threshold (tight: these are street-scale now)
const DEATH_DURATION = 0.55;     // seconds a bug spends in 'dying'
const LUNGE_DURATION = 0.3;
const CHOMP_DURATION = 0.35;
const CALLOUT_DURATION = 2.5;    // seconds the "PR #.. — fixed" callout stays up
const MAX_DT = 0.1;              // clamp so a tab-switch hitch can't teleport anything
const UI_TIME_SCALE = 0.15;      // softening factor applied while a panel has focus

const EMPTY_EVENTS = Object.freeze([]);

/* ------------------------------------------------------------------ */
/* Small deterministic helpers (mirrors the FNV-1a style already used  */
/* in src/lib/layout.js and src/components/Hazards.jsx)                */
/* ------------------------------------------------------------------ */

function hashStr(s) {
  let h = 2166136261;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function clampSev(s) {
  const n = Number(s);
  return Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : 1;
}

/** mulberry32-style step: mutates obj.seed (uint32) in place, returns a value in [0, 1). */
function nextRand(obj) {
  obj.seed = (obj.seed + 0x6d2b79f5) | 0;
  let t = obj.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Accept a Building[] (as CityLayout.buildings) or an already-built id->Building map. */
function toBuildingMap(buildings) {
  if (!buildings) return {};
  if (Array.isArray(buildings)) {
    const map = {};
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i];
      if (b && b.id != null) map[b.id] = b;
    }
    return map;
  }
  return buildings;
}

/** One roaming Greptile, idle and seeded from its pack-index at creation. */
function makeGreptile(id, x, z) {
  return {
    id,
    x,
    z,
    vx: 0,
    vz: 0,
    angle: 0,
    mode: 'idle', // 'idle' | 'hunt' | 'lunge' | 'chomp'
    modeT: 0,
    targetId: null,
    hasBitten: false,
    catches: 0,
    calloutT: 0,
    lastCatch: { bugId: null, kind: null, title: null, number: null, prNumber: null, x: 0, z: 0 },
    seed: hashStr('greptile-roam:' + id),
    roamT: 0,
    roamTX: x,
    roamTZ: z,
  };
}

/* ------------------------------------------------------------------ */
/* createChase                                                         */
/* ------------------------------------------------------------------ */

/**
 * @param {import('./types.js').Hazard[]} hazards
 * @param {import('./types.js').Building[]|Object} buildings Array (CityLayout.buildings)
 *   or a pre-built id -> Building map (buildingsById) — both accepted.
 * @param {{maxBugs?: number, packSize?: number}} [opts]
 */
export function createChase(hazards, buildings, opts = {}) {
  const maxBugs = Number.isFinite(opts.maxBugs) && opts.maxBugs > 0 ? opts.maxBugs : DEFAULT_MAX_BUGS;
  const packSize = Number.isFinite(opts.packSize) && opts.packSize > 0 ? Math.floor(opts.packSize) : PACK_SIZE;
  const buildingMap = toBuildingMap(buildings);
  const list = Array.isArray(hazards) ? hazards.filter(Boolean) : [];

  const bugHazards = list
    .filter((h) => h && h.id != null && (h.kind === 'issue' || h.kind === 'risk') && h.path && buildingMap[h.path])
    .sort((a, b) => clampSev(b.severity) - clampSev(a.severity) || String(a.id).localeCompare(String(b.id)))
    .slice(0, maxBugs);

  // buildingId -> first 'pr' hazard targeting it. Only used to enrich the kill
  // callout ("PR #123 — fixed"); PRs no longer drive targeting (the player does).
  const prByBuilding = new Map();
  for (let i = 0; i < list.length; i++) {
    const h = list[i];
    if (h && h.kind === 'pr' && h.path && !prByBuilding.has(h.path)) prByBuilding.set(h.path, h);
  }

  const bugs = [];
  const bugById = new Map();
  const perBuildingIdx = new Map();
  for (let i = 0; i < bugHazards.length; i++) {
    const h = bugHazards[i];
    const building = buildingMap[h.path];
    const idxOnBuilding = perBuildingIdx.get(h.path) || 0;
    perBuildingIdx.set(h.path, idxOnBuilding + 1);
    const hash = hashStr(String(h.id));
    const w = Number.isFinite(building.w) && building.w > 0 ? building.w : 2;
    const dd = Number.isFinite(building.d) && building.d > 0 ? building.d : 2;
    const ang = (hash % 6283) / 1000 + idxOnBuilding * 0.9;
    const dist = Math.max(w, dd) * 0.5 + BUG_ANCHOR_MARGIN + (((hash >>> 8) % 100) / 100) * 1.4;
    const ax = (Number.isFinite(building.x) ? building.x : 0) + Math.cos(ang) * dist;
    const az = (Number.isFinite(building.z) ? building.z : 0) + Math.sin(ang) * dist;
    const sev = clampSev(h.severity);
    const bug = {
      id: h.id,
      buildingId: h.path,
      kind: h.kind,
      severity: sev,
      title: h.title || '',
      number: Number.isFinite(h.number) ? h.number : null,
      // anchor: fixed point near the building the bug never wanders far from
      ax,
      az,
      x: ax,
      z: az,
      // current wander target
      tx: ax,
      tz: az,
      vx: 0,
      vz: 0,
      heading: ang, // facing angle (atan2 convention: 0 = +Z), for renderer orientation
      anchorRadius: 1.6 + sev * 0.18,
      seed: (hash ^ 0x9e3779b9) >>> 0,
      burstT: (hash % 700) / 1000, // stagger initial timers so bugs don't move in lockstep
      pausing: false,
      state: 'alive', // 'alive' | 'dying' | 'dead'
      deathT: 0,
    };
    bugs.push(bug);
    bugById.set(bug.id, bug);
  }

  // Bug-cluster centroid — used as a fallback spawn area when there's no
  // building geometry to spread the pack across.
  let cx = 0;
  let cz = 0;
  if (bugs.length) {
    for (let i = 0; i < bugs.length; i++) {
      cx += bugs[i].ax;
      cz += bugs[i].az;
    }
    cx /= bugs.length;
    cz /= bugs.length;
  }

  // City bounds (from building positions) so the pack spreads across the
  // whole map, not just the bug cluster — "several of them roaming the city".
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const key in buildingMap) {
    const b = buildingMap[key];
    if (!b) continue;
    const x = Number.isFinite(b.x) ? b.x : 0;
    const z = Number.isFinite(b.z) ? b.z : 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) {
    minX = cx - 20; maxX = cx + 20; minZ = cz - 20; maxZ = cz + 20;
  }
  const spanX = Math.max(20, maxX - minX);
  const spanZ = Math.max(20, maxZ - minZ);

  const greptiles = [];
  for (let i = 0; i < packSize; i++) {
    const hg = hashStr('greptile-spawn:' + i);
    const gx = minX + ((hg % 10007) / 10007) * spanX;
    const gz = minZ + (((hg >>> 9) % 10007) / 10007) * spanZ;
    greptiles.push(makeGreptile('g' + i, gx, gz));
  }
  const greptileById = new Map();
  for (let i = 0; i < greptiles.length; i++) greptileById.set(greptiles[i].id, greptiles[i]);

  const state = {
    time: 0,
    bugs,
    bugById,
    prByBuilding,
    greptiles,
    greptileById,
    lastDispatchedId: greptiles.length ? greptiles[0].id : null,
    events: [],
    opts: {
      maxBugs,
      packSize,
      captureRadius: CAPTURE_RADIUS,
      bugSpeed: BUG_SPEED,
      greptileSpeed: GREPTILE_SPEED,
      deathDuration: DEATH_DURATION,
      lungeDuration: LUNGE_DURATION,
      chompDuration: CHOMP_DURATION,
      calloutDuration: CALLOUT_DURATION,
    },
  };
  // Back-compat alias: anything still reading `state.greptile` (singular)
  // transparently sees the primary (first) creature in the pack.
  Object.defineProperty(state, 'greptile', {
    get() { return state.greptiles[0] || null; },
    enumerable: true,
    configurable: true,
  });
  return state;
}

/* ------------------------------------------------------------------ */
/* Assignment API — the player deploys a Greptile onto a specific bug  */
/* ------------------------------------------------------------------ */

/**
 * Send the nearest IDLE Greptile after a specific bug. If every creature is
 * already busy, preempts whichever creature is nearest overall (a deploy
 * press should never be a no-op). If some creature is already hunting this
 * exact bug, this is a no-op. Safe to call before the previous kill lands —
 * cancels any in-progress lunge/chomp on the old target for whichever
 * creature gets (re)dispatched.
 * @param {Object} state
 * @param {string|null|undefined} bugId
 * @returns {'ok'|'invalid'|'not-found'|'dead'}
 */
export function assignTarget(state, bugId) {
  if (!state || !state.bugById || !Array.isArray(state.greptiles) || state.greptiles.length === 0) return 'invalid';
  if (bugId == null) return 'invalid';
  const bug = state.bugById.get(bugId);
  if (!bug) return 'not-found';
  if (bug.state !== 'alive') return 'dead';

  const greptiles = state.greptiles;

  // Already being hunted by someone — don't double-dispatch.
  for (let i = 0; i < greptiles.length; i++) {
    const g = greptiles[i];
    if (g.targetId === bug.id && g.mode !== 'idle') {
      state.lastDispatchedId = g.id;
      return 'ok';
    }
  }

  let bestIdle = -1;
  let bestIdleD2 = Infinity;
  let bestAny = -1;
  let bestAnyD2 = Infinity;
  for (let i = 0; i < greptiles.length; i++) {
    const g = greptiles[i];
    const dx = bug.x - g.x;
    const dz = bug.z - g.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestAnyD2) { bestAnyD2 = d2; bestAny = i; }
    if (g.mode === 'idle' && d2 < bestIdleD2) { bestIdleD2 = d2; bestIdle = i; }
  }
  const chosen = greptiles[bestIdle >= 0 ? bestIdle : bestAny];
  chosen.targetId = bug.id;
  chosen.mode = 'hunt';
  chosen.modeT = 0;
  chosen.hasBitten = false;
  state.lastDispatchedId = chosen.id;
  return 'ok';
}

/* ------------------------------------------------------------------ */
/* stepChase                                                            */
/* ------------------------------------------------------------------ */

/**
 * Advances the simulation in place. Clamps dt so a tab-switch hitch can't
 * teleport anything. Returns `state` for convenience (chaining), but nothing
 * is reallocated — callers should keep using the same reference they created.
 * @param {Object} state
 * @param {number} dt seconds
 */
export function stepChase(state, dt) {
  if (!state || !Array.isArray(state.bugs) || !Array.isArray(state.greptiles)) return state;

  let d = Number.isFinite(dt) ? dt : 0;
  if (d < 0) d = 0;
  if (d > MAX_DT) d = MAX_DT;

  // A separate targeting/input component just sets these two fields on the
  // shared playerState singleton — consume the request here so nothing else
  // has to import this module to drive a dispatch.
  if (playerState.deployRequested) {
    playerState.deployRequested = false;
    if (playerState.targetedBug != null) assignTarget(state, playerState.targetedBug);
  }

  // Soften (not freeze) the sim while a review/dialogue panel has focus.
  const scale = playerState.uiFocused ? UI_TIME_SCALE : 1;
  const sd = d * scale;
  state.time += sd;

  const bugs = state.bugs;
  for (let i = 0; i < bugs.length; i++) {
    const b = bugs[i];
    if (b.state === 'dead') continue; // terminal — fixed issues stay fixed
    if (b.state === 'dying') {
      b.deathT += sd;
      if (b.deathT >= DEATH_DURATION) b.state = 'dead';
      continue;
    }
    stepBugWander(b, sd);
  }

  const greptiles = state.greptiles;
  for (let i = 0; i < greptiles.length; i++) {
    const g = greptiles[i];
    advanceGreptile(state, g, sd);
    if (g.calloutT > 0) {
      g.calloutT -= sd;
      if (g.calloutT < 0) g.calloutT = 0;
    }
  }

  return state;
}

/** Bursty, non-linear near-anchor wander: short dashes to a new nearby point,
 *  alternating with pauses, both timed by a per-bug deterministic RNG. */
function stepBugWander(b, d) {
  b.burstT -= d;
  if (b.burstT <= 0) {
    const r1 = nextRand(b);
    if (r1 < 0.4) {
      // pause in place for a beat
      b.pausing = true;
      b.tx = b.x;
      b.tz = b.z;
      b.burstT = 0.3 + nextRand(b) * 0.7;
    } else {
      // dash toward a new point within the wander radius
      b.pausing = false;
      const ang = nextRand(b) * Math.PI * 2;
      const rad = b.anchorRadius * (0.3 + nextRand(b) * 0.7);
      b.tx = b.ax + Math.cos(ang) * rad;
      b.tz = b.az + Math.sin(ang) * rad;
      b.burstT = 0.25 + nextRand(b) * 0.45;
    }
  }

  const dx = b.tx - b.x;
  const dz = b.tz - b.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  const speed = b.pausing ? 0 : BUG_SPEED * (1.2 - b.severity * 0.02);
  if (dist > 1e-4 && speed > 0) {
    const inv = 1 / dist;
    b.vx = dx * inv * speed;
    b.vz = dz * inv * speed;
    b.heading = Math.atan2(b.vx, b.vz);
  } else {
    b.vx = 0;
    b.vz = 0;
  }
  b.x += b.vx * d;
  b.z += b.vz * d;

  // hard safety clamp: never drift far from the anchor building regardless of
  // any steering slop above
  const adx = b.x - b.ax;
  const adz = b.z - b.az;
  const adist = Math.sqrt(adx * adx + adz * adz);
  const maxR = b.anchorRadius * 1.6;
  if (adist > maxR && adist > 1e-4) {
    const s = maxR / adist;
    b.x = b.ax + adx * s;
    b.z = b.az + adz * s;
  }
}

/** Steer (g.x, g.z) toward (tx, tz) at `speed`, updating vx/vz/angle in place. */
function steerToward(g, tx, tz, speed, d) {
  const dx = tx - g.x;
  const dz = tz - g.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist > 1e-4) {
    const inv = 1 / dist;
    g.vx = dx * inv * speed;
    g.vz = dz * inv * speed;
    g.angle = Math.atan2(g.vx, g.vz);
  } else {
    g.vx = 0;
    g.vz = 0;
  }
  g.x += g.vx * d;
  g.z += g.vz * d;
}

/** Idle roam: deterministic wander/pause loop, same shape as bug wander but
 *  slower and over a much bigger radius, so each Greptile still reads as
 *  "alive and present, going about its business" while it has no assignment.
 *  Each creature's `seed` is independent (hashed from its pack id), so the
 *  pack fans out and drifts apart rather than moving in lockstep. */
function stepRoam(g, d) {
  g.roamT -= d;
  if (g.roamT <= 0) {
    const r1 = nextRand(g);
    if (r1 < 0.4) {
      g.roamTX = g.x;
      g.roamTZ = g.z;
      g.roamT = 1.5 + nextRand(g) * 2.5; // pause and "look around"
    } else {
      const ang = nextRand(g) * Math.PI * 2;
      const rad = ROAM_STEP_MIN + nextRand(g) * (ROAM_STEP_MAX - ROAM_STEP_MIN);
      g.roamTX = g.x + Math.cos(ang) * rad;
      g.roamTZ = g.z + Math.sin(ang) * rad;
      g.roamT = 2.5 + nextRand(g) * 3.5;
    }
  }
  steerToward(g, g.roamTX, g.roamTZ, GREPTILE_ROAM_SPEED, d);
}

/** Advance one Greptile (`g`, an element of state.greptiles). */
function advanceGreptile(state, g, d) {
  if (g.mode === 'idle') {
    stepRoam(g, d);
    return;
  }

  const target = g.targetId != null ? state.bugById.get(g.targetId) : null;
  if (!target || target.state !== 'alive') {
    // Defensive: target vanished without going through a chomp (shouldn't
    // normally happen since only a Greptile kills bugs) — fall back to idle
    // rather than getting stuck chasing nothing.
    g.targetId = null;
    g.mode = 'idle';
    g.modeT = 0;
    g.hasBitten = false;
    return;
  }

  g.modeT += d;

  if (g.mode === 'hunt') {
    steerToward(g, target.x, target.z, GREPTILE_SPEED, d);
    const dx = target.x - g.x;
    const dz = target.z - g.z;
    if (Math.sqrt(dx * dx + dz * dz) <= CAPTURE_RADIUS) {
      g.mode = 'lunge';
      g.modeT = 0;
    }
  } else if (g.mode === 'lunge') {
    steerToward(g, target.x, target.z, GREPTILE_SPEED * 1.6, d);
    if (g.modeT >= LUNGE_DURATION) {
      g.mode = 'chomp';
      g.modeT = 0;
      g.hasBitten = false;
    }
  } else if (g.mode === 'chomp') {
    if (!g.hasBitten && g.modeT >= CHOMP_DURATION * 0.5) {
      catchBug(state, target, g);
      g.hasBitten = true;
    }
    if (g.modeT >= CHOMP_DURATION) {
      // Kill landed — no auto-retarget. Back to idle roam until the player
      // deploys this creature (or another) at its next target.
      g.mode = 'idle';
      g.modeT = 0;
      g.targetId = null;
      g.hasBitten = false;
    }
  }
}

function catchBug(state, bug, g) {
  bug.state = 'dying';
  bug.deathT = 0;
  bug.vx = 0;
  bug.vz = 0;

  const pr = state.prByBuilding.get(bug.buildingId) || null;
  const prNumber = pr && Number.isFinite(pr.number) ? pr.number : null;

  g.catches += 1;
  const lc = g.lastCatch;
  lc.bugId = bug.id;
  lc.kind = bug.kind;
  lc.title = bug.title;
  lc.number = bug.number;
  lc.prNumber = prNumber;
  lc.x = bug.x;
  lc.z = bug.z;
  g.calloutT = CALLOUT_DURATION;

  // Rare event (one per kill, player-paced) — fine to allocate here.
  state.events.push({
    type: 'kill',
    bugId: bug.id,
    buildingId: bug.buildingId,
    kind: bug.kind,
    severity: bug.severity,
    title: bug.title,
    number: bug.number,
    prNumber,
    greptileId: g.id,
    x: bug.x,
    z: bug.z,
    time: state.time,
  });
}

/**
 * Drain + return any kill events queued since the last call. Returns a shared
 * frozen empty array (no allocation) when nothing happened this tick/frame.
 * @param {Object} state
 */
export function drainEvents(state) {
  if (!state || !Array.isArray(state.events) || state.events.length === 0) return EMPTY_EVENTS;
  const out = state.events;
  state.events = [];
  return out;
}

/* ------------------------------------------------------------------ */
/* chaseStats                                                          */
/* ------------------------------------------------------------------ */

/**
 * `greptilePos`/`targetId` report the most-recently-dispatched creature (or
 * the pack's primary/first member if nothing's been dispatched yet) so any
 * existing single-creature consumer keeps working. `greptiles` is the new
 * full-pack view.
 * @param {Object} state
 * @returns {{bugsAlive: number, bugsCaught: number, targetId: string|null,
 *   greptilePos: {x:number, z:number},
 *   greptiles: Array<{id:string, x:number, z:number, mode:string, targetId:string|null}>}}
 */
export function chaseStats(state) {
  if (!state || !Array.isArray(state.bugs) || !Array.isArray(state.greptiles) || state.greptiles.length === 0) {
    return { bugsAlive: 0, bugsCaught: 0, targetId: null, greptilePos: { x: 0, z: 0 }, greptiles: [] };
  }
  let alive = 0;
  for (let i = 0; i < state.bugs.length; i++) {
    if (state.bugs[i].state === 'alive') alive++;
  }
  let totalCatches = 0;
  for (let i = 0; i < state.greptiles.length; i++) totalCatches += state.greptiles[i].catches;

  const primary = (state.lastDispatchedId && state.greptileById.get(state.lastDispatchedId)) || state.greptiles[0];

  return {
    bugsAlive: alive,
    bugsCaught: totalCatches,
    targetId: primary.targetId,
    greptilePos: { x: primary.x, z: primary.z },
    greptiles: state.greptiles.map((g) => ({ id: g.id, x: g.x, z: g.z, mode: g.mode, targetId: g.targetId })),
  };
}
