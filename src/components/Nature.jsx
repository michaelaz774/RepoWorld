/**
 * Nature — voxel street trees and park greenery.
 *
 * VOXEL ART DIRECTION: everything here is built from a single unit cube
 * (`BOX_GEOM`) with baked per-face shading (top brightest, bottom darkest,
 * sides medium) as vertex colors. Trees are deterministic clusters of whole
 * blocks — a 1x1 trunk column topped with a chunky leaf-block canopy — never
 * smooth/curved geometry. Four variants: oak (wide canopy), birch (taller,
 * pale trunk), a small leaf-only bush, and a conifer (stepped leaf pyramid).
 * Per-instance trunk height / canopy size / facing is chosen deterministically
 * by hashing a stable seed string (road id, plot id, index) — never
 * Math.random — and snapped to whole blocks / quarter turns.
 *
 * Parks (`Plot.kind === 'park'`) get a flat grass slab, a scatter of trees
 * (oak/birch/conifer), a scatter of bushes, and — for larger parks — a dirt
 * path slab across the middle.
 *
 * PERFORMANCE: every block (trunk, leaf, grass slab, path slab, at every
 * street tree and every park) is one instance of ONE shared BoxGeometry
 * rendered by a SINGLE THREE.InstancedMesh — one draw call for this entire
 * file. Matrices/colors are computed once in useMemo; nothing is touched
 * per-frame (no useFrame at all — static blocks don't sway).
 */
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

const MAX_STREET_TREES = 500;   // cap on street-tree count (not block count)
const MAX_PARK_TREES = 400;
const MAX_PARK_BUSHES = 260;
const MAX_PARK_FLOWERS = 900;
const MAX_PARK_GRASS = 900;
const TREE_SPACING = 9;         // world units between street trees
const TREE_INSET = 4;           // don't plant right at a road's endpoints
const CURB_GAP = 1.8;           // trunk sits this far beyond the paved edge
const BUILDING_PAD = 0.6;       // keep clear of building footprints

/* ------------------------------------------------------------------ */
/* Deterministic hashing (FNV-1a) — no Math.random anywhere            */
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
function hash01(s) {
  return (hashStr(s) % 1000003) / 1000003;
}
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/* ------------------------------------------------------------------ */
/* Shared voxel geometry + material (module singletons)                */
/* ------------------------------------------------------------------ */

/** Bake per-face brightness into a vertex color attribute (flat voxel shading). */
function shadeBoxGeometry(geo) {
  const normal = geo.attributes.normal;
  const count = normal.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const ny = normal.getY(i);
    const nz = normal.getZ(i);
    const nx = normal.getX(i);
    let b;
    if (ny > 0.5) b = 1.0;
    else if (ny < -0.5) b = 0.55;
    else if (nz > 0.5) b = 0.85;
    else if (nz < -0.5) b = 0.72;
    else if (nx > 0.5) b = 0.8;
    else b = 0.68;
    colors[i * 3] = b;
    colors[i * 3 + 1] = b;
    colors[i * 3 + 2] = b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

// Unit block, pivot at the bottom face (so instance position == block base).
const BOX_GEOM = shadeBoxGeometry(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));

let _voxelMaterial = null;
function getVoxelMaterial() {
  if (!_voxelMaterial) {
    _voxelMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  }
  return _voxelMaterial;
}

const BLOCK_COLORS = {
  wood: '#8a5a34',
  birch: '#d9d3b8',
  leafOak: '#4f9a34',
  leafBirch: '#7fbf4a',
  leafConifer: '#356b3f',
  leafBush: '#4a8f3a',
  grass: '#5fae3f',
  dirt: '#8a6b46',
};

// A handful of alternate leaf hues per tree family so a whole street of oaks doesn't read
// as one copy-pasted tree — picked deterministically per-plant, never Math.random.
const LEAF_PALETTE = {
  leafOak: ['#4f9a34', '#5aa83c', '#3f8a2c', '#7a9a3a'], // last one: dry/olive accent tree
  leafBirch: ['#7fbf4a', '#8fcf5a', '#c8b04a'], // last one: light autumn-gold birch
  leafConifer: ['#356b3f', '#2e5f38', '#3f7548'],
  leafBush: ['#4a8f3a', '#569c44', '#3d8232'],
};

const FLOWER_COLORS = ['#e0546a', '#e8c33f', '#eeeeee', '#7e5ac2'];

function pickLeafColor(role, seed) {
  const palette = LEAF_PALETTE[role];
  if (!palette) return BLOCK_COLORS[role];
  return palette[hashStr(seed + ':hue:' + role) % palette.length];
}

function tintedColor(hex, tint) {
  const c = new THREE.Color(hex);
  c.r = Math.min(1, c.r * tint);
  c.g = Math.min(1, c.g * tint);
  c.b = Math.min(1, c.b * tint);
  return c;
}

/* ------------------------------------------------------------------ */
/* Tree variants — deterministic block clusters (local integer offsets) */
/* ------------------------------------------------------------------ */

function oakBlocks(trunkH, apex) {
  const blocks = [];
  for (let y = 0; y < trunkH; y++) blocks.push([0, y, 0, 'wood']);
  const h = trunkH;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) blocks.push([dx, h, dz, 'leafOak']);
  }
  const plus = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dz] of plus) blocks.push([dx, h + 1, dz, 'leafOak']);
  if (apex) blocks.push([0, h + 2, 0, 'leafOak']);
  return blocks;
}

function birchBlocks(trunkH) {
  const blocks = [];
  for (let y = 0; y < trunkH; y++) blocks.push([0, y, 0, 'birch']);
  const h = trunkH;
  const plus = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dz] of plus) blocks.push([dx, h, dz, 'leafBirch']);
  blocks.push([0, h + 1, 0, 'leafBirch']);
  return blocks;
}

function bushBlocks(big, dir) {
  const blocks = [];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  blocks.push([0, 0, 0, 'leafBush']);
  if (!big) {
    const [dx, dz] = dirs[dir % 4];
    blocks.push([dx, 0, dz, 'leafBush']);
  } else {
    for (const [dx, dz] of dirs) blocks.push([dx, 0, dz, 'leafBush']);
    blocks.push([0, 1, 0, 'leafBush']);
  }
  return blocks;
}

function coniferBlocks(tall) {
  const blocks = [];
  blocks.push([0, 0, 0, 'wood']);
  let y = 1;
  if (tall) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) blocks.push([dx, y, dz, 'leafConifer']);
    }
    y++;
  }
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) blocks.push([dx, y, dz, 'leafConifer']);
  }
  y++;
  const plus = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dz] of plus) blocks.push([dx, y, dz, 'leafConifer']);
  y++;
  blocks.push([0, y, 0, 'leafConifer']);
  return blocks;
}

/** Rotate integer (dx,dz) offsets by a multiple of 90 degrees around Y. */
function rotateXZ(dx, dz, turns) {
  let x = dx;
  let z = dz;
  for (let t = 0; t < (turns & 3); t++) {
    const nx = -z;
    const nz = x;
    x = nx;
    z = nz;
  }
  return [x, z];
}

/** variant: 0 oak, 1 birch, 2 bush, 3 conifer */
function buildVariantBlocks(seed, variant) {
  if (variant === 0) {
    const trunkH = 3 + (hashStr(seed + ':h') % 3); // 3-5
    const apex = (hashStr(seed + ':a') % 2) === 0;
    return oakBlocks(trunkH, apex);
  }
  if (variant === 1) {
    const trunkH = 5 + (hashStr(seed + ':h') % 3); // 5-7
    return birchBlocks(trunkH);
  }
  if (variant === 2) {
    const big = (hashStr(seed + ':b') % 2) === 0;
    const dir = hashStr(seed + ':d') % 4;
    return bushBlocks(big, dir);
  }
  const tall = (hashStr(seed + ':tl') % 2) === 0;
  return coniferBlocks(tall);
}

/** Push one plant's blocks (world-positioned, quarter-turned, tinted) onto `list`. */
function pushPlant(list, x, z, seed, variant) {
  const turns = hashStr(seed + ':r') % 4;
  const tint = 0.88 + hash01(seed + ':tint') * 0.24;
  const raw = buildVariantBlocks(seed, variant);
  for (let i = 0; i < raw.length; i++) {
    const dx = raw[i][0];
    const dy = raw[i][1];
    const dz = raw[i][2];
    const role = raw[i][3];
    const [rx, rz] = rotateXZ(dx, dz, turns);
    const baseHex = LEAF_PALETTE[role] ? pickLeafColor(role, seed) : BLOCK_COLORS[role];
    list.push({
      x: x + rx,
      y: dy,
      z: z + rz,
      sx: 1,
      sy: 1,
      sz: 1,
      color: tintedColor(baseHex, tint),
    });
  }
}

function addStreetTree(list, x, z, seed) {
  pushPlant(list, x, z, seed, hashStr(seed + ':v') % 4);
}
function addParkTree(list, x, z, seed) {
  const roll = hashStr(seed + ':v') % 3; // oak / birch / conifer (no bush here)
  pushPlant(list, x, z, seed, roll === 2 ? 3 : roll);
}
function addBush(list, x, z, seed) {
  pushPlant(list, x, z, seed, 2);
}

/** A single low flower block, half-height and a hair narrower than a full block (small-prop
 *  half-block scale is allowed by the art direction), colored from a small deterministic
 *  palette so a park reads as a mixed flower bed, not one repeated sprite. Placed at a
 *  fractional world position — these are small props, not grid-snapped terrain blocks. */
function addFlower(list, x, z, seed) {
  const color = FLOWER_COLORS[hashStr(seed + ':fc') % FLOWER_COLORS.length];
  const tint = 0.9 + hash01(seed + ':ft') * 0.2;
  list.push({ x, y: 0, z, sx: 0.34, sy: 0.32, sz: 0.34, color: tintedColor(color, tint) });
}

/** A tall-grass tuft: a slim, taller-than-flower green block. */
function addTallGrass(list, x, z, seed) {
  const tint = 0.85 + hash01(seed + ':gt') * 0.3;
  list.push({
    x,
    y: 0,
    z,
    sx: 0.3,
    sy: 0.55,
    sz: 0.3,
    color: tintedColor(pickLeafColor('leafBush', seed), tint),
  });
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

/* ------------------------------------------------------------------ */
/* Layout -> flat instance list                                        */
/* ------------------------------------------------------------------ */

/**
 * @param {import('../lib/types.js').RoadSegment[]} roads
 * @param {import('../lib/types.js').Plot[]} plots
 * @param {import('../lib/types.js').Building[]} buildings
 */
function buildNatureInstances(roads, plots, buildings) {
  const blocks = [];
  let treeCount = 0;
  let bushCount = 0;
  let flowerCount = 0;
  let grassCount = 0;

  // --- street trees along road edges, on the sidewalk side ---
  for (let r = 0; r < roads.length && treeCount < MAX_STREET_TREES; r++) {
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
    const ux = dx / len;
    const uz = dz / len;
    const px = -uz;
    const pz = ux;
    const halfW = (Number.isFinite(road.width) && road.width > 0 ? road.width : 6) / 2;
    const offset = halfW + CURB_GAP;
    const usable = len - TREE_INSET * 2;
    if (usable <= 0) continue;
    const n = Math.floor(usable / TREE_SPACING);
    for (let i = 0; i <= n && treeCount < MAX_STREET_TREES; i++) {
      const t = TREE_INSET + i * TREE_SPACING;
      for (const side of [-1, 1]) {
        if (treeCount >= MAX_STREET_TREES) break;
        const seed = `${road.id || r}:t${i}:${side}`;
        const jitterT = (hash01(seed + ':jt') - 0.5) * 3;
        const jitterO = (hash01(seed + ':jo') - 0.5) * 0.6;
        const tt = clamp(t + jitterT, 1, len - 1);
        const cx = Math.round(x1 + ux * tt + px * side * (offset + jitterO));
        const cz = Math.round(z1 + uz * tt + pz * side * (offset + jitterO));
        if (insideAnyBuilding(cx, cz, buildings, BUILDING_PAD)) continue;
        addStreetTree(blocks, cx, cz, seed);
        treeCount++;
      }
    }
  }

  // --- parks: grass slab, tree scatter, bush scatter, optional path ---
  for (let p = 0; p < plots.length; p++) {
    const plot = plots[p];
    if (!plot || plot.kind !== 'park') continue;
    const w = Number.isFinite(plot.w) && plot.w > 0 ? plot.w : 8;
    const d = Number.isFinite(plot.d) && plot.d > 0 ? plot.d : 8;
    const px0 = Number.isFinite(plot.x) ? plot.x : 0;
    const pz0 = Number.isFinite(plot.z) ? plot.z : 0;
    const plotId = plot.id || `plot${p}`;

    blocks.push({
      x: px0,
      y: 0,
      z: pz0,
      sx: Math.max(w - 0.4, 1),
      sy: 0.12,
      sz: Math.max(d - 0.4, 1),
      color: tintedColor(BLOCK_COLORS.grass, 0.92 + hash01(`${plotId}:g`) * 0.16),
    });

    const area = w * d;
    const insetX = Math.max(w / 2 - 1.2, 0.6);
    const insetZ = Math.max(d / 2 - 1.2, 0.6);

    const treeN = Math.max(0, Math.min(Math.round(clamp(area / 16, 3, 34)), MAX_PARK_TREES - treeCount));
    for (let i = 0; i < treeN; i++) {
      const seed = `${plotId}:pt${i}`;
      const ox = (hash01(seed + ':x') * 2 - 1) * insetX;
      const oz = (hash01(seed + ':z') * 2 - 1) * insetZ;
      const cx = Math.round(px0 + ox);
      const cz = Math.round(pz0 + oz);
      if (insideAnyBuilding(cx, cz, buildings, BUILDING_PAD)) continue;
      addParkTree(blocks, cx, cz, seed);
      treeCount++;
    }

    const bushN = Math.max(0, Math.min(Math.round(clamp(area / 24, 2, 18)), MAX_PARK_BUSHES - bushCount));
    for (let i = 0; i < bushN; i++) {
      const seed = `${plotId}:pb${i}`;
      const ox = (hash01(seed + ':bx') * 2 - 1) * insetX;
      const oz = (hash01(seed + ':bz') * 2 - 1) * insetZ;
      const cx = Math.round(px0 + ox);
      const cz = Math.round(pz0 + oz);
      if (insideAnyBuilding(cx, cz, buildings, BUILDING_PAD)) continue;
      addBush(blocks, cx, cz, seed);
      bushCount++;
    }

    // flower beds + tall-grass tufts: dense, fractionally-positioned small props that make
    // a park read as planted rather than an empty grass rectangle.
    const flowerN = Math.max(0, Math.min(Math.round(clamp(area * 0.6, 4, 40)), MAX_PARK_FLOWERS - flowerCount));
    for (let i = 0; i < flowerN; i++) {
      const seed = `${plotId}:pfl${i}`;
      const ox = (hash01(seed + ':x') * 2 - 1) * insetX;
      const oz = (hash01(seed + ':z') * 2 - 1) * insetZ;
      const cx = px0 + ox;
      const cz = pz0 + oz;
      if (insideAnyBuilding(cx, cz, buildings, BUILDING_PAD)) continue;
      addFlower(blocks, cx, cz, seed);
      flowerCount++;
    }
    const grassN = Math.max(0, Math.min(Math.round(clamp(area * 0.6, 4, 40)), MAX_PARK_GRASS - grassCount));
    for (let i = 0; i < grassN; i++) {
      const seed = `${plotId}:pgr${i}`;
      const ox = (hash01(seed + ':x') * 2 - 1) * insetX;
      const oz = (hash01(seed + ':z') * 2 - 1) * insetZ;
      const cx = px0 + ox;
      const cz = pz0 + oz;
      if (insideAnyBuilding(cx, cz, buildings, BUILDING_PAD)) continue;
      addTallGrass(blocks, cx, cz, seed);
      grassCount++;
    }

    // a path slab across larger parks
    if (Math.max(w, d) > 13) {
      const alongX = w >= d;
      const length = Math.max(w, d) * 0.78;
      const pathW = 1.6;
      blocks.push({
        x: px0,
        y: 0.1,
        z: pz0,
        sx: alongX ? length : pathW,
        sy: 0.06,
        sz: alongX ? pathW : length,
        color: tintedColor(BLOCK_COLORS.dirt, 1),
      });
    }
  }

  return blocks;
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const tmpMat4 = new THREE.Matrix4();
const IDENTITY_QUAT = new THREE.Quaternion();

/**
 * @param {{layout: import('../lib/types.js').CityLayout | null}} props
 */
export default function Nature({ layout }) {
  const roads = layout?.roads || [];
  const plots = layout?.plots || [];
  const buildings = layout?.buildings || [];

  const instances = useMemo(
    () => buildNatureInstances(roads, plots, buildings),
    [roads, plots, buildings]
  );

  const mesh = useMemo(() => {
    const count = instances.length;
    if (count === 0) return null;
    const m = new THREE.InstancedMesh(BOX_GEOM, getVoxelMaterial(), count);
    m.frustumCulled = false;
    for (let i = 0; i < count; i++) {
      const it = instances[i];
      tmpPos.set(it.x, it.y, it.z);
      tmpScale.set(it.sx, it.sy, it.sz);
      tmpMat4.compose(tmpPos, IDENTITY_QUAT, tmpScale);
      m.setMatrixAt(i, tmpMat4);
      m.setColorAt(i, it.color);
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    // Thousands of tiny leaf/flower instances would make an expensive shadow caster for
    // little visual payoff (per the perf budget, only ground + buildings cast) — but they
    // should still receive the dappled shade buildings and their own canopies throw.
    m.receiveShadow = true;
    m.castShadow = false;
    return m;
  }, [instances]);

  useEffect(() => () => { if (mesh) mesh.dispose(); }, [mesh]);

  if (!mesh) return null;
  return <primitive object={mesh} />;
}
