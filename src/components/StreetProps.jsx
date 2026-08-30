/**
 * StreetProps — voxel street furniture: streetlights, benches, bollards,
 * trash bins, planters and signs.
 *
 * Deliberately NO parked cars: every car in the world is a drivable one placed
 * by Cars.jsx, so a car you walk up to is always a car you can get into.
 *
 * VOXEL ART DIRECTION: every prop is a small compound of axis-aligned unit
 * cubes sharing Ground.jsx's `getVoxelGeometry()` (one BoxGeometry, baked
 * per-face shading as vertex colors, pivoted at its bottom face) so the
 * whole world — terrain, trees, props — draws from a single geometry.
 * Nothing is rotated by an arbitrary angle: since `RoadSegment`s are always
 * axis-aligned, "along the road" is always exactly world X or world Z, so
 * elongated props (arms, bench seats, sign plates) just swap
 * which box dimension is the long one instead of using a quaternion.
 * Everything is placed deterministically by hashing a stable seed string
 * (road id, plot id, index) via Ground.jsx's `hashStr` — no Math.random.
 *
 * Streetlights get a warm "glowing" lamp block on top instead of a real
 * point light (hundreds of dynamic lights would tank the frame rate) — the
 * head is a flat unshaded block, plus a cheap additive ground glow quad with
 * a tiny (16px) nearest-filtered radial texture standing in for a light pool.
 *
 * Placement never lands on a building footprint (`layout.buildings`) or a
 * road cell (`Ground.jsx`'s `computeRoadCells`, shared so props agree
 * exactly with the pavement Ground/Roads already drew).
 *
 * PERFORMANCE: three InstancedMesh draw calls total for this whole file —
 * one for every solid block (poles, arms, benches, bollards, bins,
 * planters, signs), one for lamp heads, one for ground light-pool
 * quads. Matrices/colors built once in useMemo; no per-frame work at all.
 */
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { getVoxelGeometry, makePixelTexture, computeRoadCells, cellKey, hashStr } from './Ground.jsx';

/* ------------------------------------------------------------------ */
/* Deterministic helpers                                               */
/* ------------------------------------------------------------------ */

function hash01(s) {
  return (hashStr(s) % 1000003) / 1000003;
}
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
function insideAnyBuilding(x, z, buildings, pad) {
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    if (!b) continue;
    const hw = (Number.isFinite(b.w) && b.w > 0 ? b.w : 2) / 2 + pad;
    const hd = (Number.isFinite(b.d) && b.d > 0 ? b.d : 2) / 2 + pad;
    if (Math.abs(x - (b.x || 0)) <= hw && Math.abs(z - (b.z || 0)) <= hd) return true;
  }
  return false;
}
/** True if (x,z) falls on a road cell or inside a building footprint — never place a prop there. */
function blocked(x, z, buildings, roadCells) {
  if (insideAnyBuilding(x, z, buildings, 0.6)) return true;
  return roadCells.has(cellKey(Math.floor(x), Math.floor(z)));
}

/* ------------------------------------------------------------------ */
/* Shared voxel geometry + materials (module singletons)               */
/* ------------------------------------------------------------------ */

// Same unit block as Ground.jsx/Nature.jsx — one geometry for the whole world.
const VOXEL_GEOM = getVoxelGeometry();
// Flat quad for the ground light pool, lying on the XZ plane.
const POOL_GEOM = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

let _voxelMaterial = null;
function getPropMaterial() {
  if (!_voxelMaterial) {
    _voxelMaterial = new THREE.MeshLambertMaterial({
      vertexColors: true,
      map: makePixelTexture('#ffffff', 0.08, 'streetprops-fleck', 16),
    });
  }
  return _voxelMaterial;
}

// Lamp heads use a plain (non-vertex-colored) material on the SAME shared geometry so the
// baked face-shading is ignored and the block reads as a flat, glowing block instead.
let _lampMaterial = null;
function getLampMaterial() {
  if (!_lampMaterial) {
    _lampMaterial = new THREE.MeshBasicMaterial({ color: '#fff0b8' });
  }
  return _lampMaterial;
}

let _poolTex;
function getPoolTexture() {
  if (_poolTex !== undefined) return _poolTex;
  if (typeof document === 'undefined') {
    _poolTex = null;
    return _poolTex;
  }
  const size = 32;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(255,222,168,0.9)');
  grd.addColorStop(0.6, 'rgba(255,200,130,0.35)');
  grd.addColorStop(1, 'rgba(255,200,130,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  _poolTex = tex;
  return tex;
}

let _poolMaterial = null;
function getPoolMaterial() {
  if (!_poolMaterial) {
    _poolMaterial = new THREE.MeshBasicMaterial({
      map: getPoolTexture(),
      color: '#ffdca0',
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }
  return _poolMaterial;
}

/* ------------------------------------------------------------------ */
/* Prop builders — push {x,y,z,sx,sy,sz,color} block descriptors        */
/* ------------------------------------------------------------------ */

function pushBox(list, x, y, z, sx, sy, sz, colorHex) {
  list.push({ x, y, z, sx, sy, sz, color: new THREE.Color(colorHex) });
}

/** Small deterministic brightness jitter so a street of identical benches/bins/planters
 *  doesn't read as one copy-pasted asset repeated end to end. */
function jitteredColor(colorHex, seed) {
  const c = new THREE.Color(colorHex);
  c.offsetHSL(0, 0, (hash01(seed + ':jit') - 0.5) * 0.14);
  return c;
}
function pushJitteredBox(list, x, y, z, sx, sy, sz, colorHex, seed) {
  list.push({ x, y, z, sx, sy, sz, color: jitteredColor(colorHex, seed) });
}

function addStreetlight(blocks, glows, pools, x, z, alongX, side, seed) {
  const poleH = 6.0 + hash01(seed + ':ph');
  pushJitteredBox(blocks, x, 0, z, 0.24, poleH, 0.24, '#888d92', seed);
  const reach = 1.3;
  const dx = alongX ? 0 : -side * reach;
  const dz = alongX ? -side * reach : 0;
  const midX = x + dx * 0.5;
  const midZ = z + dz * 0.5;
  const armSx = alongX ? 0.2 : reach;
  const armSz = alongX ? reach : 0.2;
  pushBox(blocks, midX, poleH - 0.3, midZ, armSx, 0.2, armSz, '#888d92');
  const hx = x + dx;
  const hz = z + dz;
  glows.push({ x: hx, y: poleH - 0.55, z: hz, sx: 0.42, sy: 0.3, sz: 0.42 });
  pools.push({ x: hx, y: 0.03, z: hz, s: 2.4 });
}

function addBench(blocks, x, z, alongX, seed) {
  const seatSx = alongX ? 1.6 : 0.5;
  const seatSz = alongX ? 0.5 : 1.6;
  pushJitteredBox(blocks, x, 0.42, z, seatSx, 0.14, seatSz, '#7a5636', seed);
  const backOff = 0.22;
  const bx = alongX ? x : x - backOff;
  const bz = alongX ? z - backOff : z;
  const backSx = alongX ? 1.6 : 0.12;
  const backSz = alongX ? 0.12 : 1.6;
  pushJitteredBox(blocks, bx, 0.75, bz, backSx, 0.5, backSz, '#7a5636', seed);
  const legOffset = 0.65;
  const legPositions = alongX ? [[-legOffset, 0], [legOffset, 0]] : [[0, -legOffset], [0, legOffset]];
  for (const [ldx, ldz] of legPositions) {
    pushBox(blocks, x + ldx, 0.1, z + ldz, 0.12, 0.32, 0.12, '#5c4327');
  }
}

function addBollard(blocks, x, z, seed) {
  pushJitteredBox(blocks, x, 0, z, 0.26, 0.9, 0.26, '#d1571f', seed);
}

function addTrashBin(blocks, x, z, seed) {
  pushJitteredBox(blocks, x, 0, z, 0.5, 0.78, 0.5, '#48524a', seed);
  pushBox(blocks, x, 0.78, z, 0.56, 0.12, 0.56, '#2f3630');
}

function addHydrant(blocks, x, z, seed) {
  pushJitteredBox(blocks, x, 0, z, 0.34, 0.58, 0.34, '#c23b2e', seed);
  pushBox(blocks, x, 0.58, z, 0.4, 0.14, 0.4, '#8a2e24');
}

function addPlanter(blocks, x, z, seed) {
  pushBox(blocks, x, 0, z, 0.8, 0.38, 0.8, '#8a6b4a');
  pushJitteredBox(blocks, x, 0.38, z, 0.56, 0.34, 0.56, '#4a8f3a', seed);
}

function addSign(blocks, x, z, alongX, seed) {
  pushBox(blocks, x, 0, z, 0.12, 2.2, 0.12, '#707070');
  const plateSx = alongX ? 0.6 : 0.06;
  const plateSz = alongX ? 0.06 : 0.6;
  const color = hashStr(seed + ':c') % 2 === 0 ? '#2f6fae' : '#e0b23c';
  pushBox(blocks, x, 1.9, z, plateSx, 0.5, plateSz, color);
}

function addFurniture(blocks, x, z, alongX, seed) {
  const pick = hashStr(seed + ':kind') % 5;
  if (pick === 0) addBench(blocks, x, z, alongX, seed);
  else if (pick === 1) addBollard(blocks, x, z, seed);
  else if (pick === 2) addTrashBin(blocks, x, z, seed);
  else if (pick === 3) addHydrant(blocks, x, z, seed);
  else addPlanter(blocks, x, z, seed);
}

/* ------------------------------------------------------------------ */
/* Layout -> flat instance lists                                       */
/* ------------------------------------------------------------------ */

const LIGHT_SPACING = 16;
const LIGHT_INSET = 5;
const LIGHT_GAP = 2.4;
const FURN_SPACING = 24;
const FURN_INSET = 6;
const FURN_GAP = 1.5;
const MAX_LIGHTS = 260;
const MAX_FURN = 220;
const MAX_SIGNS = 120;

/**
 * @param {import('../lib/types.js').RoadSegment[]} roads
 * @param {import('../lib/types.js').Plot[]} plots
 * @param {import('../lib/types.js').Building[]} buildings
 * @param {Map<string,{kind:string}>} roadCells
 */
function buildStreetPropInstances(roads, plots, buildings, roadCells) {
  const blocks = [];
  const glows = [];
  const pools = [];
  let lightCount = 0;
  let furnitureCount = 0;
  let signCount = 0;
  const signSeen = new Set();

  for (let r = 0; r < roads.length; r++) {
    const road = roads[r];
    if (!road) continue;
    const x1 = Number.isFinite(road.x1) ? road.x1 : 0;
    const z1 = Number.isFinite(road.z1) ? road.z1 : 0;
    const x2 = Number.isFinite(road.x2) ? road.x2 : 0;
    const z2 = Number.isFinite(road.z2) ? road.z2 : 0;
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    if (len < 2) continue;
    const alongX = Math.abs(dx) >= Math.abs(dz);
    const ux = dx / len;
    const uz = dz / len;
    const px = -uz;
    const pz = ux;
    const halfW = (Number.isFinite(road.width) && road.width > 0 ? road.width : 6) / 2;
    const roadId = road.id || r;

    // street signs near both ends of the segment (deduped so shared
    // intersections don't get doubled up)
    if (signCount < MAX_SIGNS) {
      const ends = [[x1, z1], [x2, z2]];
      for (const [ex, ez] of ends) {
        const key = Math.round(ex * 2) / 2 + ',' + Math.round(ez * 2) / 2;
        if (signSeen.has(key)) continue;
        signSeen.add(key);
        const sx = Math.round(ex + px * (halfW + 1.4));
        const sz = Math.round(ez + pz * (halfW + 1.4));
        if (blocked(sx, sz, buildings, roadCells)) continue;
        addSign(blocks, sx, sz, alongX, `${roadId}:sign:${key}`);
        signCount++;
        if (signCount >= MAX_SIGNS) break;
      }
    }

    // streetlights, alternating sides
    const usableL = len - LIGHT_INSET * 2;
    if (usableL > 0 && lightCount < MAX_LIGHTS) {
      const nL = Math.floor(usableL / LIGHT_SPACING);
      for (let i = 0; i <= nL && lightCount < MAX_LIGHTS; i++) {
        const seed = `${roadId}:light:${i}`;
        const t = LIGHT_INSET + i * LIGHT_SPACING + (hash01(seed + ':j') - 0.5) * 2;
        const side = i % 2 === 0 ? -1 : 1;
        const tt = clamp(t, 1, len - 1);
        const cx = Math.round(x1 + ux * tt + px * side * (halfW + LIGHT_GAP));
        const cz = Math.round(z1 + uz * tt + pz * side * (halfW + LIGHT_GAP));
        if (blocked(cx, cz, buildings, roadCells)) continue;
        addStreetlight(blocks, glows, pools, cx, cz, alongX, side, seed);
        lightCount++;
      }
    }

    // street furniture: bench / bollard / trash bin / hydrant / planter
    const usableF = len - FURN_INSET * 2;
    if (usableF > 0 && furnitureCount < MAX_FURN) {
      const nF = Math.floor(usableF / FURN_SPACING);
      for (let i = 0; i <= nF && furnitureCount < MAX_FURN; i++) {
        const seed = `${roadId}:furn:${i}`;
        if (hash01(seed + ':skip') < 0.35) continue;
        const t = clamp(FURN_INSET + i * FURN_SPACING + (hash01(seed + ':jt') - 0.5) * 4, 1, len - 1);
        const side = hashStr(seed + ':side') % 2 === 0 ? -1 : 1;
        const cx = Math.round(x1 + ux * t + px * side * (halfW + FURN_GAP));
        const cz = Math.round(z1 + uz * t + pz * side * (halfW + FURN_GAP));
        if (blocked(cx, cz, buildings, roadCells)) continue;
        addFurniture(blocks, cx, cz, alongX, seed);
        furnitureCount++;
      }
    }
  }

  // plaza furniture
  for (let p = 0; p < plots.length; p++) {
    const plot = plots[p];
    if (!plot) continue;
    const w = Number.isFinite(plot.w) && plot.w > 0 ? plot.w : 8;
    const d = Number.isFinite(plot.d) && plot.d > 0 ? plot.d : 8;
    const px0 = Number.isFinite(plot.x) ? plot.x : 0;
    const pz0 = Number.isFinite(plot.z) ? plot.z : 0;
    const plotId = plot.id || `plot${p}`;

    if (plot.kind === 'plaza' && furnitureCount < MAX_FURN) {
      const n = Math.min(6, MAX_FURN - furnitureCount);
      for (let i = 0; i < n; i++) {
        const seed = `${plotId}:pf${i}`;
        const edge = hashStr(seed + ':edge') % 4;
        const along = hash01(seed + ':along') * 2 - 1;
        let cx;
        let cz;
        let alongX;
        if (edge === 0) { cx = px0 + along * (w / 2 - 0.8); cz = pz0 - d / 2 + 0.6; alongX = true; }
        else if (edge === 1) { cx = px0 + along * (w / 2 - 0.8); cz = pz0 + d / 2 - 0.6; alongX = true; }
        else if (edge === 2) { cx = px0 - w / 2 + 0.6; cz = pz0 + along * (d / 2 - 0.8); alongX = false; }
        else { cx = px0 + w / 2 - 0.6; cz = pz0 + along * (d / 2 - 0.8); alongX = false; }
        cx = Math.round(cx);
        cz = Math.round(cz);
        if (blocked(cx, cz, buildings, roadCells)) continue;
        addFurniture(blocks, cx, cz, alongX, seed);
        furnitureCount++;
      }
    }
  }

  return { blocks, glows, pools };
}

/* ------------------------------------------------------------------ */
/* Component                                                            */
/* ------------------------------------------------------------------ */

const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const tmpMat4 = new THREE.Matrix4();
const IDENTITY_QUAT = new THREE.Quaternion();

function buildBlockMesh(list) {
  const count = list.length;
  if (count === 0) return null;
  const m = new THREE.InstancedMesh(VOXEL_GEOM, getPropMaterial(), count);
  m.frustumCulled = false;
  for (let i = 0; i < count; i++) {
    const it = list[i];
    tmpPos.set(it.x, it.y, it.z);
    tmpScale.set(it.sx, it.sy, it.sz);
    tmpMat4.compose(tmpPos, IDENTITY_QUAT, tmpScale);
    m.setMatrixAt(i, tmpMat4);
    m.setColorAt(i, it.color);
  }
  m.instanceMatrix.needsUpdate = true;
  if (m.instanceColor) m.instanceColor.needsUpdate = true;
  // Small props: cheap to receive shade, not worth the shadow-pass cost of casting it.
  m.receiveShadow = true;
  m.castShadow = false;
  return m;
}

function buildGlowMesh(list) {
  const count = list.length;
  if (count === 0) return null;
  const m = new THREE.InstancedMesh(VOXEL_GEOM, getLampMaterial(), count);
  m.frustumCulled = false;
  for (let i = 0; i < count; i++) {
    const it = list[i];
    tmpPos.set(it.x, it.y, it.z);
    tmpScale.set(it.sx, it.sy, it.sz);
    tmpMat4.compose(tmpPos, IDENTITY_QUAT, tmpScale);
    m.setMatrixAt(i, tmpMat4);
  }
  m.instanceMatrix.needsUpdate = true;
  return m;
}

function buildPoolMesh(list) {
  const count = list.length;
  if (count === 0) return null;
  const m = new THREE.InstancedMesh(POOL_GEOM, getPoolMaterial(), count);
  m.frustumCulled = false;
  for (let i = 0; i < count; i++) {
    const it = list[i];
    tmpPos.set(it.x, it.y, it.z);
    tmpScale.set(it.s, 1, it.s);
    tmpMat4.compose(tmpPos, IDENTITY_QUAT, tmpScale);
    m.setMatrixAt(i, tmpMat4);
  }
  m.instanceMatrix.needsUpdate = true;
  return m;
}

/**
 * @param {{layout: import('../lib/types.js').CityLayout | null}} props
 */
export default function StreetProps({ layout }) {
  const roads = layout?.roads || [];
  const plots = layout?.plots || [];
  const buildings = layout?.buildings || [];

  const roadCells = useMemo(() => computeRoadCells(roads), [roads]);

  const { blocks, glows, pools } = useMemo(
    () => buildStreetPropInstances(roads, plots, buildings, roadCells),
    [roads, plots, buildings, roadCells]
  );

  const blockMesh = useMemo(() => buildBlockMesh(blocks), [blocks]);
  const glowMesh = useMemo(() => buildGlowMesh(glows), [glows]);
  const poolMesh = useMemo(() => buildPoolMesh(pools), [pools]);

  useEffect(() => () => { if (blockMesh) blockMesh.dispose(); }, [blockMesh]);
  useEffect(() => () => { if (glowMesh) glowMesh.dispose(); }, [glowMesh]);
  useEffect(() => () => { if (poolMesh) poolMesh.dispose(); }, [poolMesh]);

  if (!blockMesh && !glowMesh && !poolMesh) return null;

  return (
    <group>
      {poolMesh && <primitive object={poolMesh} />}
      {blockMesh && <primitive object={blockMesh} />}
      {glowMesh && <primitive object={glowMesh} />}
    </group>
  );
}
