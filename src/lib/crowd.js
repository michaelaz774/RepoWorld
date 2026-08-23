/**
 * crowd.js — deterministic pedestrian crowd simulation over the sidewalk graph.
 *
 * Pure logic only (no three.js imports) so it's fully unit-testable. Agents walk
 * between linked `PathNode`s (see src/lib/types.js) at a per-agent human walking
 * speed, picking a new target node on arrival. Everything is seeded from the
 * agent index via a mulberry32-style hash — there is no `Math.random()` anywhere,
 * so a given `paths` + `count` always produces the same crowd, and replaying the
 * same sequence of `stepCrowd` calls always produces the same positions.
 *
 * Graph model: a node's own `links` array is treated as directed "this node can
 * walk to that node," but to stay robust against asymmetrically-authored sidewalk
 * data (A lists B, B doesn't list A) the adjacency actually used for movement is
 * the *symmetric closure* of the authored links: if A links to B, both A->B and
 * B->A become usable. This is what lets a walker reverse back the way it came
 * when it hits a true dead end (out-degree 1), and it means any node an agent can
 * ever arrive at always has degree >= 1 (see buildGraph/pickNext comments).
 *
 * Node coordinates are cached once (in `createCrowd`) into typed arrays on
 * `crowd.graph`; `stepCrowd`/`agentPosition` read from that cache rather than
 * re-reading `paths` every frame, so the per-frame path is allocation-free and
 * immune to `paths` being re-created with the same topology on every render.
 * `stepCrowd` still accepts `paths` (matching the required signature) for
 * API symmetry / future validation, but does not need to dereference it.
 */

const MAX_DT = 0.12; // seconds; clamp so a hitch (tab switch, GC pause) can't
                      // skip an agent past multiple nodes in one step.
const MIN_SPEED = 1.2; // u/s — human walking speed range
const MAX_SPEED = 1.6;
const STRIDE_FREQ = 1.8; // phase radians advanced per unit of distance walked
const EPS = 1e-6;

/* ------------------------------------------------------------------ */
/* Deterministic hashing (mulberry32-style) — no Math.random anywhere  */
/* ------------------------------------------------------------------ */

function mulberryAdvance(state) {
  return (state + 0x6d2b79f5) | 0;
}

function mulberryMix(state) {
  let t = state;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Stable initial RNG state for agent `i` (evolves across arrivals afterward). */
function seedFor(i) {
  return mulberryAdvance((i + 0x9e3779b9) | 0);
}

/** Stable, non-evolving [0,1) value derived from (index, salt) — used for the
 * one-time per-agent traits (speed/build/color/start position) that must stay
 * fixed for the agent's whole lifetime regardless of how many steps have run. */
function hash01(i, salt) {
  const h = mulberryAdvance((Math.imul(i + 1, 2654435761) ^ Math.imul(salt + 1, 0x85ebca6b)) | 0);
  return mulberryMix(h);
}

/* ------------------------------------------------------------------ */
/* Graph construction                                                  */
/* ------------------------------------------------------------------ */

/**
 * Validate `paths` and build a symmetric adjacency (CSR: adjIndex/adjList),
 * tolerating missing coordinates, self-links, out-of-range indices, and
 * non-array `links`. Never throws.
 * @param {import('./types.js').PathNode[]} paths
 */
function buildGraph(paths) {
  const nodes = Array.isArray(paths) ? paths : [];
  const n = nodes.length;
  const nodeX = new Float64Array(n);
  const nodeZ = new Float64Array(n);
  const valid = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = nodes[i];
    const x = p && Number.isFinite(p.x) ? p.x : 0;
    const z = p && Number.isFinite(p.z) ? p.z : 0;
    nodeX[i] = x;
    nodeZ[i] = z;
    valid[i] = p && Number.isFinite(p.x) && Number.isFinite(p.z) ? 1 : 0;
  }

  const adjSets = new Array(n);
  for (let i = 0; i < n; i++) adjSets[i] = new Set();
  for (let i = 0; i < n; i++) {
    if (!valid[i]) continue;
    const links = nodes[i] && Array.isArray(nodes[i].links) ? nodes[i].links : [];
    for (let k = 0; k < links.length; k++) {
      const j = links[k];
      if (!Number.isInteger(j) || j < 0 || j >= n || j === i || !valid[j]) continue;
      adjSets[i].add(j);
      adjSets[j].add(i); // symmetric closure — see file header
    }
  }

  const adjIndex = new Int32Array(n + 1);
  let total = 0;
  for (let i = 0; i < n; i++) {
    adjIndex[i] = total;
    total += adjSets[i].size;
  }
  adjIndex[n] = total;
  const adjList = new Int32Array(total);
  for (let i = 0; i < n; i++) {
    let p = adjIndex[i];
    for (const j of adjSets[i]) adjList[p++] = j;
  }

  return { n, nodeX, nodeZ, adjIndex, adjList };
}

/**
 * Deterministically choose the next node to walk to from `curNode`, given the
 * node just arrived from (`prevNode`, or -1 if none yet). Avoids immediately
 * reversing unless `curNode` is a true dead end (degree 1). Advances the
 * agent's rolling RNG state by exactly one step (so repeated arrivals produce
 * a deterministic, varied sequence of choices).
 */
function pickNext(graph, curNode, prevNode, rngState, agentIdx) {
  const start = graph.adjIndex[curNode];
  const end = graph.adjIndex[curNode + 1];
  const deg = end - start;
  if (deg <= 0) return curNode; // isolated node — park in place, never NaN/crash
  if (deg === 1) return graph.adjList[start]; // dead end: only option, may reverse

  let prevPos = -1;
  for (let k = 0; k < deg; k++) {
    if (graph.adjList[start + k] === prevNode) {
      prevPos = k;
      break;
    }
  }
  const usable = prevPos >= 0 ? deg - 1 : deg;

  rngState[agentIdx] = mulberryAdvance(rngState[agentIdx]);
  const r = mulberryMix(rngState[agentIdx]);
  let pick = Math.floor(r * usable);
  if (pick >= usable) pick = usable - 1;
  if (prevPos >= 0 && pick >= prevPos) pick += 1; // skip over the excluded slot
  return graph.adjList[start + pick];
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

function emptyCrowd(graph) {
  return {
    count: 0,
    graph,
    curNode: new Int32Array(0),
    nextNode: new Int32Array(0),
    prevNode: new Int32Array(0),
    t: new Float32Array(0),
    speed: new Float32Array(0),
    phase: new Float32Array(0),
    rngState: new Int32Array(0),
    heightScale: new Float32Array(0),
    buildScale: new Float32Array(0),
    hue: new Float32Array(0),
  };
}

/**
 * Build a deterministic crowd of agents walking `paths` (the sidewalk graph).
 * Never throws; an empty/degenerate/unusable graph yields `count: 0`.
 * `count` scales down automatically for small graphs so a tiny sidewalk
 * network doesn't get an absurd number of pedestrians crammed onto it.
 * @param {import('./types.js').PathNode[]} paths
 * @param {number} count desired agent count (upper bound)
 * @param {{minSpeed?:number, maxSpeed?:number}} [opts]
 */
export function createCrowd(paths, count, opts = {}) {
  const graph = buildGraph(paths);
  const startNodes = [];
  for (let i = 0; i < graph.n; i++) {
    if (graph.adjIndex[i + 1] > graph.adjIndex[i]) startNodes.push(i);
  }

  const requested = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (graph.n === 0 || startNodes.length === 0 || requested === 0) {
    return emptyCrowd(graph);
  }

  const minSpeed = Number.isFinite(opts.minSpeed) ? opts.minSpeed : MIN_SPEED;
  const maxSpeed = Number.isFinite(opts.maxSpeed) ? opts.maxSpeed : MAX_SPEED;

  // Scale down for small/sparse graphs: roughly proportional to how much usable
  // topology exists, so e.g. a 6-node graph never gets 120 people on it.
  const totalDirectedEdges = graph.adjList.length; // each undirected edge counted twice
  const cap = Math.max(
    Math.min(4, startNodes.length),
    Math.min(requested, Math.round(totalDirectedEdges * 2.5), startNodes.length * 10)
  );
  const m = Math.max(0, Math.min(requested, cap));
  if (m === 0) return emptyCrowd(graph);

  const curNode = new Int32Array(m);
  const nextNode = new Int32Array(m);
  const prevNode = new Int32Array(m).fill(-1);
  const t = new Float32Array(m);
  const speed = new Float32Array(m);
  const phase = new Float32Array(m);
  const rngState = new Int32Array(m);
  const heightScale = new Float32Array(m);
  const buildScale = new Float32Array(m);
  const hue = new Float32Array(m);

  for (let i = 0; i < m; i++) {
    const startPick = Math.floor(hash01(i, 1) * startNodes.length);
    const sIdx = startNodes[startPick < startNodes.length ? startPick : startNodes.length - 1];
    curNode[i] = sIdx;
    rngState[i] = seedFor(i);
    nextNode[i] = pickNext(graph, sIdx, -1, rngState, i);
    t[i] = 0;
    speed[i] = minSpeed + hash01(i, 2) * (maxSpeed - minSpeed);
    phase[i] = hash01(i, 3) * Math.PI * 2;
    heightScale[i] = 0.9 + hash01(i, 4) * 0.28;
    buildScale[i] = 0.85 + hash01(i, 5) * 0.3;
    hue[i] = hash01(i, 6);
  }

  return {
    count: m,
    graph,
    curNode,
    nextNode,
    prevNode,
    t,
    speed,
    phase,
    rngState,
    heightScale,
    buildScale,
    hue,
  };
}

/**
 * Advance every agent by `dt` seconds, in place, with zero allocation. `dt` is
 * internally clamped so a large hitch cannot move an agent past more than one
 * node arrival in a single call. `paths` is accepted for API symmetry with
 * `createCrowd` (positions used by the simulation are the cached ones built at
 * creation time — see file header) and is otherwise unused.
 * @param {ReturnType<typeof createCrowd>} crowd
 * @param {import('./types.js').PathNode[]} paths
 * @param {number} dt seconds
 */
// eslint-disable-next-line no-unused-vars
export function stepCrowd(crowd, paths, dt) {
  if (!crowd || crowd.count === 0) return;
  const clampedDt = Number.isFinite(dt) && dt > 0 ? Math.min(dt, MAX_DT) : 0;
  if (clampedDt === 0) return;

  const graph = crowd.graph;
  const n = graph.n;
  const { curNode, nextNode, prevNode, t, speed, phase, rngState } = crowd;

  for (let i = 0; i < crowd.count; i++) {
    const cur = curNode[i];
    const nxt = nextNode[i];
    if (cur < 0 || cur >= n || nxt < 0 || nxt >= n) continue; // defensive, shouldn't happen

    const dist = speed[i] * clampedDt;
    phase[i] = (phase[i] + dist * STRIDE_FREQ) % (Math.PI * 2);

    const x1 = graph.nodeX[cur];
    const z1 = graph.nodeZ[cur];
    const x2 = graph.nodeX[nxt];
    const z2 = graph.nodeZ[nxt];
    const dx = x2 - x1;
    const dz = z2 - z1;
    const edgeLen = Math.sqrt(dx * dx + dz * dz);

    if (edgeLen < EPS) {
      // Zero-length edge (coincident nodes): arrive immediately, no division.
      t[i] = 0;
      prevNode[i] = cur;
      curNode[i] = nxt;
      nextNode[i] = pickNext(graph, nxt, cur, rngState, i);
      continue;
    }

    const advanced = t[i] + dist / edgeLen;
    if (advanced >= 1) {
      t[i] = 0; // drop remainder rather than carrying it — guarantees at most
      prevNode[i] = cur; // one node transition per stepCrowd call, however
      curNode[i] = nxt; // large dt or short the edge is.
      nextNode[i] = pickNext(graph, nxt, cur, rngState, i);
    } else {
      t[i] = advanced;
    }
  }
}

/**
 * Write agent `i`'s interpolated world position/facing into `out` (no
 * allocation — reuse the same object across calls). `out.angle` is a yaw in
 * the same convention as `playerState.yaw` (0 = facing -Z), suitable for
 * `mesh.rotation.y` on a model whose forward is -Z.
 * @param {ReturnType<typeof createCrowd>} crowd
 * @param {number} i
 * @param {{x:number,z:number,angle:number}} out
 */
export function agentPosition(crowd, i, out) {
  if (!out) return out;
  if (!crowd || i < 0 || i >= crowd.count) {
    out.x = 0;
    out.z = 0;
    out.angle = 0;
    return out;
  }
  const graph = crowd.graph;
  const n = graph.n;
  const cur = crowd.curNode[i];
  const nxt = crowd.nextNode[i];
  if (cur < 0 || cur >= n || nxt < 0 || nxt >= n) {
    out.x = 0;
    out.z = 0;
    out.angle = 0;
    return out;
  }
  const x1 = graph.nodeX[cur];
  const z1 = graph.nodeZ[cur];
  const x2 = graph.nodeX[nxt];
  const z2 = graph.nodeZ[nxt];
  const tt = crowd.t[i];
  const dx = x2 - x1;
  const dz = z2 - z1;
  out.x = x1 + dx * tt;
  out.z = z1 + dz * tt;
  if (Math.abs(dx) > EPS || Math.abs(dz) > EPS) {
    out.angle = Math.atan2(-dx, -dz);
  } else if (!Number.isFinite(out.angle)) {
    out.angle = 0;
  }
  return out;
}
