/**
 * Buildings — the city, VOXEL style.
 *
 * Every building is a small stack of whole-block cubes (footprint + height
 * snapped to the 1-unit grid) built from ONE shared unit `BoxGeometry` with
 * baked-in per-face vertex-color shading (top brightest, sides medium, front/
 * back a touch darker, bottom darkest — the classic blocky look). A file's
 * `building.color` / `building.lang` picks WHICH block material the building
 * is built from (stone, lapis, oak, brick, ...) rather than tinting it neon;
 * each material is a flat `MeshLambertMaterial` with a tiny (8x8) nearest-
 * filtered canvas texture, no PBR, no emissive.
 *
 * All body/trim/window blocks across the whole city are grouped into a
 * handful of `THREE.InstancedMesh`es — one per block material, one for roof
 * trim (parapets/chimneys/antennas), one for window glass — so total draw
 * calls stay in the low teens no matter how many of the 350 buildings exist.
 *
 * Focus highlight is a single translucent shell mesh sized to the focused
 * building's footprint + full block height (mutated imperatively, never a
 * re-render of the city). Label culling + the single mounted `CodePanel`
 * trigger read the shared mutable `playerState` on a throttled interval.
 *
 * @see src/lib/types.js for the Building shape.
 */
import * as THREE from 'three';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Billboard, Text } from '@react-three/drei';
import { playerState } from '../lib/playerState.js';
import CodePanel from './CodePanel.jsx';

const LABEL_RADIUS = 45;        // only label buildings within this distance
const LABEL_RADIUS_SQ = LABEL_RADIUS * LABEL_RADIUS;
const LABEL_MAX = 40;           // hard cap on simultaneously mounted labels
const LABEL_INTERVAL = 0.2;     // seconds between label/panel re-evaluations
const PANEL_RADIUS = 10;        // focused building must be this close to show code

const WHITE = new THREE.Color('#ffffff');
const tmpColor = new THREE.Color();
const tmpMat4 = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const IDENTITY_QUAT = new THREE.Quaternion();

/* ------------------------------------------------------------------ */
/* Deterministic hashing (FNV-1a) — no Math.random anywhere.           */
/* ------------------------------------------------------------------ */

function hash32(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* ------------------------------------------------------------------ */
/* Block material palette. `building.lang` picks a block TYPE (a          */
/* material choice, e.g. "this Python file is stone") rather than tinting */
/* a neon color onto glowing plastic.                                     */
/* ------------------------------------------------------------------ */

const BLOCK_INFO = {
  stone: { color: '#9aa0a6', tex: 'stone' },
  lapis: { color: '#4c7de8', tex: 'speckle' }, // brighter royal blue — the original deep navy read as a near-black mass from a distance
  gold: { color: '#d9a441', tex: 'speckle' },
  terracotta: { color: '#b1602e', tex: 'stone' },
  oak: { color: '#9c7238', tex: 'grain' },
  brick: { color: '#a1402c', tex: 'brick' },
  emerald: { color: '#2f9e52', tex: 'speckle' },
  amethyst: { color: '#8c4fce', tex: 'speckle' },
  diamond: { color: '#49c7c2', tex: 'speckle' },
};
const BLOCK_TYPES = Object.keys(BLOCK_INFO);

const LANG_BLOCK = {
  JavaScript: 'gold',
  TypeScript: 'lapis',
  Python: 'stone',
  Rust: 'terracotta',
  Go: 'diamond',
  Java: 'oak',
  'C++': 'brick',
  C: 'stone',
  'C#': 'emerald',
  Ruby: 'brick',
  PHP: 'amethyst',
  Swift: 'terracotta',
  Kotlin: 'amethyst',
  Shell: 'emerald',
  HTML: 'gold',
  CSS: 'amethyst',
  Markdown: 'lapis',
  JSON: 'stone',
  YAML: 'brick',
  Other: 'stone',
};

function blockTypeForLang(lang) {
  return LANG_BLOCK[lang] || 'stone';
}

const WINDOW_HEX = '#7fb8d9';     // sky-reflecting glass
const WINDOW_LIT_HEX = '#fff0b0'; // sun-catching pane
const TRIM_HEX = '#7d8288';       // cobble-ish roof trim, distinct from any body type

/* ------------------------------------------------------------------ */
/* Tiny nearest-filtered canvas textures (8x8). Generated once, shared. */
/* ------------------------------------------------------------------ */

const textureCache = new Map();
function getTinyTexture(kind) {
  if (textureCache.has(kind)) return textureCache.get(kind);
  let tex = null;
  if (typeof document !== 'undefined') {
    const size = 16;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const h = hash32(`${kind}:${x}:${y}`);
        let v;
        if (kind === 'grain') {
          // oak plank seams: wide horizontal boards (3px) with a dark seam line between them,
          // plus subtle vertical wood-grain streaks within each board.
          const board = Math.floor(y / 3);
          const seamRow = y % 3 === 2;
          v = (board % 2 === 0 ? 226 : 210) + ((h % 7) - 3);
          if (seamRow) v -= 46;
          // occasional darker grain streak
          if (!seamRow && hash32(`${kind}:grain:${x}:${board}`) % 11 === 0) v -= 20;
        } else if (kind === 'brick') {
          // running-bond brick: 2px-tall bricks, mortar lines every other row + staggered joints
          const row = Math.floor(y / 2);
          const offset = (row % 2) * 3;
          const mortarV = y % 2 === 1; // horizontal mortar course under every brick row
          const mortarH = (x + offset) % 4 === 0; // vertical joint between bricks
          v = mortarV || mortarH ? 192 : 226 + ((h % 9) - 4);
        } else if (kind === 'stone') {
          // ashlar stone blocks: 4x4 blocks with a 1px mortar grid
          const onGrid = x % 4 === 0 || y % 4 === 0;
          v = onGrid ? 196 : 224 + ((h % 15) - 7);
        } else if (kind === 'gravel') {
          // rooftop gravel/tar: coarse dark speckle, occasional pebble highlight
          v = 150 + (h % 21) - 10;
          if (h % 13 === 0) v += 30;
        } else if (kind === 'storefront') {
          // ground-floor band: dark base with a horizontal glass-line band across the middle
          const inBand = y >= size * 0.3 && y <= size * 0.7;
          v = inBand ? 165 + (h % 11) - 5 : 120 + (h % 9) - 4;
        } else if (kind === 'glassframe') {
          // window pane with a mullion border
          const border = x === 0 || y === 0 || x === size - 1 || y === size - 1 || x === size / 2 || y === size / 2;
          v = border ? 235 : 205 + (h % 13) - 6;
        } else {
          v = 224 + (h % 17) - 8;
        }
        v = Math.max(50, Math.min(250, v));
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
  }
  textureCache.set(kind, tex);
  return tex;
}

/* ------------------------------------------------------------------ */
/* Shared unit cube: BoxGeometry(1,1,1) translated so its base sits at    */
/* y=0 (spans local y:[0,1]), with baked per-face vertex-color shading — */
/* the classic blocky "top bright / sides medium / bottom dark" look,    */
/* shared by every material (multiplies with material.color + map).      */
/* ------------------------------------------------------------------ */

let sharedGeometry = null;
function getSharedGeometry() {
  if (sharedGeometry) return sharedGeometry;
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  // BoxGeometry group/materialIndex order: +x, -x, +y(top), -y(bottom), +z, -z
  const shadeByFace = [0.72, 0.72, 1.0, 0.5, 0.62, 0.62];
  const posCount = geo.attributes.position.count;
  const colors = new Float32Array(posCount * 3).fill(0.85);
  if (geo.index && geo.groups && geo.groups.length) {
    const idx = geo.index;
    for (const group of geo.groups) {
      const shade =
        shadeByFace[group.materialIndex] != null ? shadeByFace[group.materialIndex] : 0.8;
      for (let i = group.start; i < group.start + group.count; i++) {
        const vIdx = idx.getX(i);
        colors[vIdx * 3] = shade;
        colors[vIdx * 3 + 1] = shade;
        colors[vIdx * 3 + 2] = shade;
      }
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  sharedGeometry = geo;
  return sharedGeometry;
}

/* ------------------------------------------------------------------ */
/* Materials (lazy singletons, one per block type + trim + glass).       */
/* Flat MeshLambertMaterial + vertexColors (for the baked face shading + */
/* instanceColor on the glass mesh) — no metalness/roughness, no emissive.*/
/* ------------------------------------------------------------------ */

const bodyMaterialCache = new Map();
function getBodyMaterial(type) {
  if (bodyMaterialCache.has(type)) return bodyMaterialCache.get(type);
  const info = BLOCK_INFO[type] || BLOCK_INFO.stone;
  const mat = new THREE.MeshLambertMaterial({
    color: info.color,
    map: getTinyTexture(info.tex),
    vertexColors: true,
  });
  bodyMaterialCache.set(type, mat);
  return mat;
}

let trimMaterialSingleton = null;
function getTrimMaterial() {
  if (!trimMaterialSingleton) {
    trimMaterialSingleton = new THREE.MeshLambertMaterial({
      color: TRIM_HEX,
      map: getTinyTexture('gravel'),
      vertexColors: true,
    });
  }
  return trimMaterialSingleton;
}

/** Ground-floor "shopfront" band: one shared material for every building's lowest tier,
 *  distinct from the upper-floor body texture (item: ground floor differs from upper floors). */
let storefrontMaterialSingleton = null;
function getStorefrontMaterial() {
  if (!storefrontMaterialSingleton) {
    storefrontMaterialSingleton = new THREE.MeshLambertMaterial({
      color: '#dfe3e6',
      map: getTinyTexture('storefront'),
      vertexColors: true,
    });
  }
  return storefrontMaterialSingleton;
}

let glassMaterialSingleton = null;
function getGlassMaterial() {
  if (!glassMaterialSingleton) {
    glassMaterialSingleton = new THREE.MeshLambertMaterial({
      color: '#ffffff',
      map: getTinyTexture('glassframe'),
      vertexColors: true,
    });
  }
  return glassMaterialSingleton;
}

/* ------------------------------------------------------------------ */
/* Per-building block-stack generator. Deterministic from building.path. */
/* Snaps footprint/height to whole blocks and produces a small archetype  */
/* silhouette: low-rise (shopfront + flat/pitched roof), mid-rise         */
/* (stepped setback + parapet corners), high-rise (multi-tier tower +     */
/* antenna/chimney cluster) — plus a scatter of glass window blocks on    */
/* the main tier's four faces.                                            */
/* ------------------------------------------------------------------ */

function buildBuildingBlocks(b) {
  const type = blockTypeForLang(b.lang);
  const bx = Number.isFinite(b.x) ? b.x : 0;
  const bz = Number.isFinite(b.z) ? b.z : 0;
  const bw = Math.max(1, Math.round(Number.isFinite(b.w) && b.w > 0 ? b.w : 2));
  const bd = Math.max(1, Math.round(Number.isFinite(b.d) && b.d > 0 ? b.d : 2));
  const bh = Math.max(2, Math.round(Number.isFinite(b.height) && b.height > 0 ? b.height : 4));
  const seed = hash32(b.path || b.id || b.name || '');

  const body = [];
  const trim = [];
  let topY = 0;

  function addBody(w, h, d, cx = bx, cz = bz, y0 = topY) {
    body.push({ x: cx, z: cz, y: y0, w, h, d });
  }
  function addTrim(w, h, d, cx, cz, y0) {
    trim.push({ x: cx, z: cz, y: y0, w, h, d });
  }

  if (bh <= 5) {
    // Low-rise: shopfront body + flat parapet lip OR a chunky stepped
    // "pitched" roof, plus an occasional chimney nub.
    const mainH = Math.max(1, bh - 1);
    addBody(bw, mainH, bd);
    topY = mainH;
    const pitched = (seed & 1) === 1;
    if (pitched && bw > 2 && bd > 2) {
      const iw = bw - 2;
      const id = bd - 2;
      addBody(iw, 1, id, bx, bz, topY);
      topY += 1;
      if (iw > 2 && id > 2 && ((seed >>> 2) & 1) === 1) {
        addTrim(Math.max(1, iw - 2), 1, Math.max(1, id - 2), bx, bz, topY);
        topY += 1;
      }
    } else {
      addBody(bw, 1, bd, bx, bz, topY); // flat roof cap / parapet lip
      topY += 1;
    }
    if (((seed >>> 4) % 10) < 3) {
      const signX = (seed >>> 5) & 1 ? 1 : -1;
      const signZ = (seed >>> 6) & 1 ? 1 : -1;
      const cx = bx + Math.max(0, bw / 2 - 0.5) * signX;
      const cz = bz + Math.max(0, bd / 2 - 0.5) * signZ;
      addTrim(1, 2, 1, cx, cz, topY);
      topY += 2;
    }
  } else if (bh <= 15) {
    // Mid-rise: banded body, one stepped setback near the top, optional
    // parapet corner blocks.
    const h1 = Math.max(1, Math.round(bh * 0.6));
    const h2 = Math.max(1, bh - h1);
    addBody(bw, h1, bd);
    topY = h1;
    const w2 = bw > 2 ? bw - 2 : bw;
    const d2 = bd > 2 ? bd - 2 : bd;
    addBody(w2, h2, d2, bx, bz, topY);
    topY += h2;
    if (((seed >>> 3) & 1) === 1) {
      const hx = w2 / 2 - 0.5;
      const hz = d2 / 2 - 0.5;
      if (hx > 0 && hz > 0) {
        addTrim(1, 1, 1, bx - hx, bz - hz, topY);
        addTrim(1, 1, 1, bx + hx, bz - hz, topY);
        addTrim(1, 1, 1, bx - hx, bz + hz, topY);
        addTrim(1, 1, 1, bx + hx, bz + hz, topY);
      }
      topY += 1;
    }
  } else {
    // High-rise: 3-tier stepped tower + antenna or a rooftop chimney
    // cluster / AC units.
    const h1 = Math.max(1, Math.round(bh * 0.45));
    const h2 = Math.max(1, Math.round(bh * 0.35));
    const h3 = Math.max(1, bh - h1 - h2);
    addBody(bw, h1, bd);
    topY = h1;
    const w2 = bw > 2 ? bw - 2 : bw;
    const d2 = bd > 2 ? bd - 2 : bd;
    addBody(w2, h2, d2, bx, bz, topY);
    topY += h2;
    const w3 = w2 > 2 ? w2 - 2 : w2;
    const d3 = d2 > 2 ? d2 - 2 : d2;
    addBody(w3, h3, d3, bx, bz, topY);
    topY += h3;
    const roofPick = (seed >>> 7) % 3;
    if (roofPick === 0) {
      const antH = 2 + ((seed >>> 9) % 3);
      addTrim(1, antH, 1, bx, bz, topY);
      topY += antH;
    } else if (roofPick === 1) {
      const hx = Math.max(0, w3 / 2 - 0.5);
      const hz = Math.max(0, d3 / 2 - 0.5);
      addTrim(1, 1, 1, bx + hx, bz + hz, topY);
      addTrim(1, 1, 1, bx - hx, bz - hz, topY);
      topY += 1;
    } else {
      // rooftop mechanical/AC cluster: a scatter of small boxes instead of a single feature
      addTrim(Math.min(w3, 1.4), 0.7, Math.min(d3, 1.4), bx - w3 * 0.2, bz - d3 * 0.2, topY);
      addTrim(Math.min(w3, 1), 0.5, Math.min(d3, 1), bx + w3 * 0.22, bz + d3 * 0.15, topY);
      topY += 0.7;
    }
  }

  // Ground-floor "shopfront" band: a proud (fractionally oversized) 1-unit-tall shell
  // wrapping the base of the main tier in a distinct material, so the ground floor always
  // reads differently from the walls above it — the classic storefront-vs-upper-floors look.
  const storefront = [];
  if (body.length && body[0].h >= 3) {
    const b0 = body[0];
    storefront.push({ x: b0.x, z: b0.z, y: 0, w: b0.w + 0.03, h: 1, d: b0.d + 0.03 });
  }

  // Window glass: a regular grid of small proud blocks on the main tier's
  // four faces. Lit/unlit is a deterministic hash of building path + cell.
  const glass = [];
  const mainH = body[0].h;
  const rows = Math.max(1, Math.min(10, Math.floor((mainH - 1) / 2)));
  const colsAlongZ = Math.max(1, Math.min(5, Math.floor((bd - 1) / 2))); // for +-X faces
  const colsAlongX = Math.max(1, Math.min(5, Math.floor((bw - 1) / 2))); // for +-Z faces
  const faces = [
    { axis: 'x', sign: 1, cols: colsAlongZ },
    { axis: 'x', sign: -1, cols: colsAlongZ },
    { axis: 'z', sign: 1, cols: colsAlongX },
    { axis: 'z', sign: -1, cols: colsAlongX },
  ];
  for (const f of faces) {
    for (let r = 0; r < rows; r++) {
      const rowBase = 1 + r * 2;
      const centerY = rowBase + 1;
      if (centerY + 0.3 > mainH) break;
      for (let c = 0; c < f.cols; c++) {
        const t = (c + 1) / (f.cols + 1) - 0.5; // -0.5..0.5 across the face
        const lit = (hash32(`${b.path}|${f.axis}${f.sign}|${r}|${c}`) % 10) < 2;
        const sy = 0.6;
        let px;
        let pz;
        let sx;
        let sz;
        if (f.axis === 'x') {
          px = bx + f.sign * (bw / 2 + 0.07);
          pz = bz + t * bd;
          sx = 0.14;
          sz = 0.6;
        } else {
          pz = bz + f.sign * (bd / 2 + 0.07);
          px = bx + t * bw;
          sx = 0.6;
          sz = 0.14;
        }
        glass.push({ x: px, z: pz, y: centerY - sy / 2, w: sx, h: sy, d: sz, lit });
      }
    }
  }

  return { type, body, trim, storefront, glass, topY };
}

/* ------------------------------------------------------------------ */
/* Standalone single-building mesh (previews / non-instanced use). Not    */
/* used for the city bulk — exported for reuse (highlights, tests).       */
/* @param {{building: import('../lib/types.js').Building, focused?: boolean}} props
/* ------------------------------------------------------------------ */

export function BuildingMesh({ building, focused = false }) {
  if (!building) return null;
  const x = Number.isFinite(building.x) ? building.x : 0;
  const z = Number.isFinite(building.z) ? building.z : 0;
  const w = Math.max(1, Math.round(Number.isFinite(building.w) && building.w > 0 ? building.w : 2));
  const d = Math.max(1, Math.round(Number.isFinite(building.d) && building.d > 0 ? building.d : 2));
  const h = Math.max(
    2,
    Math.round(Number.isFinite(building.height) && building.height > 0 ? building.height : 4)
  );
  const type = blockTypeForLang(building.lang);
  const bodyMat = getBodyMaterial(type);
  const trimMat = getTrimMaterial();
  const geometry = getSharedGeometry();
  const mainH = Math.max(1, h - 1);
  return (
    <group>
      <mesh
        geometry={geometry}
        material={bodyMat}
        position={[x, 0, z]}
        scale={[w, mainH, d]}
        castShadow
        receiveShadow
      />
      <mesh
        geometry={geometry}
        material={trimMat}
        position={[x, mainH, z]}
        scale={[w, 1, d]}
        castShadow
        receiveShadow
      />
      {focused ? (
        <mesh position={[x, h / 2, z]} scale={[w + 0.3, h + 0.3, d + 0.3]}>
          <boxGeometry args={[1, 1, 1]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.2} depthWrite={false} />
        </mesh>
      ) : null}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Helpers to turn a flat entry list into an InstancedMesh.               */
/* ------------------------------------------------------------------ */

function buildInstancedMesh(entries, material, tintPerEntry, castsShadow = true) {
  const count = entries.length;
  if (count === 0) return null;
  const mesh = new THREE.InstancedMesh(getSharedGeometry(), material, count);
  mesh.frustumCulled = false;
  for (let i = 0; i < count; i++) {
    const e = entries[i];
    tmpPos.set(e.x, e.y, e.z);
    tmpScale.set(e.w, e.h, e.d);
    tmpMat4.compose(tmpPos, IDENTITY_QUAT, tmpScale);
    mesh.setMatrixAt(i, tmpMat4);
    if (tintPerEntry) {
      tmpColor.set(e.lit ? WINDOW_LIT_HEX : WINDOW_HEX);
      mesh.setColorAt(i, tmpColor);
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  // Buildings are the city's big shadow casters/receivers; glass stays receive-only (thin
  // proud panes casting shadows looks wrong and it's not worth the extra shadow-pass cost).
  mesh.receiveShadow = true;
  mesh.castShadow = castsShadow;
  return mesh;
}

/* ------------------------------------------------------------------ */
/* The city                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {{buildings?: import('../lib/types.js').Building[], fetchCode?: ((path: string) => Promise<string>)|null}} props
 */
export default function Buildings({ buildings = [], fetchCode = null }) {
  const list = useMemo(
    () => (Array.isArray(buildings) ? buildings.filter(Boolean) : []),
    [buildings]
  );

  const { meshes, idToBuilding, idToTop } = useMemo(() => {
    const bucketArrays = new Map();
    for (const t of BLOCK_TYPES) bucketArrays.set(t, []);
    const trimEntries = [];
    const storefrontEntries = [];
    const glassEntries = [];
    const buildingMap = new Map();
    const topMap = new Map();

    for (const b of list) {
      const built = buildBuildingBlocks(b);
      const arr = bucketArrays.get(built.type) || bucketArrays.get('stone');
      for (const box of built.body) arr.push(box);
      for (const box of built.trim) trimEntries.push(box);
      for (const box of built.storefront) storefrontEntries.push(box);
      for (const box of built.glass) glassEntries.push(box);
      if (b.id != null) {
        buildingMap.set(b.id, b);
        topMap.set(b.id, built.topY);
      }
    }

    const list_ = [];
    for (const t of BLOCK_TYPES) {
      const m = buildInstancedMesh(bucketArrays.get(t), getBodyMaterial(t), false);
      if (m) list_.push(m);
    }
    const trimMesh = buildInstancedMesh(trimEntries, getTrimMaterial(), false);
    if (trimMesh) list_.push(trimMesh);
    const storefrontMesh = buildInstancedMesh(storefrontEntries, getStorefrontMaterial(), false);
    if (storefrontMesh) list_.push(storefrontMesh);
    const glassMesh = buildInstancedMesh(glassEntries, getGlassMaterial(), true, false);
    if (glassMesh) list_.push(glassMesh);

    return { meshes: list_, idToBuilding: buildingMap, idToTop: topMap };
  }, [list]);

  useEffect(
    () => () => {
      for (const m of meshes) m.dispose();
    },
    [meshes]
  );

  // --- focus highlight: a single translucent shell, mutated imperatively ---
  const glowRef = useRef(null);
  const focusRef = useRef(null);

  useEffect(() => {
    focusRef.current = null;
    if (glowRef.current) glowRef.current.visible = false;
  }, [meshes]);

  // --- React state that changes rarely (labels + code panel) ---
  const [nearLabels, setNearLabels] = useState([]);
  const [panelId, setPanelId] = useState(null);
  const labelKeyRef = useRef('');
  const panelIdRef = useRef(null);
  const accRef = useRef(0);

  useFrame((state, delta) => {
    // 1) Focus highlight shell: cheap compare every frame, mutate on change.
    const fid = playerState.focusedBuilding;
    if (fid !== focusRef.current) {
      focusRef.current = fid;
      const glow = glowRef.current;
      if (glow) {
        const b = fid != null ? idToBuilding.get(fid) : null;
        const top = fid != null ? idToTop.get(fid) : null;
        if (b && Number.isFinite(top)) {
          const w = (Number.isFinite(b.w) && b.w > 0 ? Math.round(b.w) : 2) + 0.4;
          const d = (Number.isFinite(b.d) && b.d > 0 ? Math.round(b.d) : 2) + 0.4;
          const h = top + 0.4;
          glow.scale.set(w, h, d);
          glow.position.set(b.x || 0, h / 2 - 0.15, b.z || 0);
          try {
            glow.material.color.set(b.color || '#ffffff').lerp(WHITE, 0.5);
          } catch {
            glow.material.color.set('#ffffff');
          }
          glow.visible = true;
        } else {
          glow.visible = false;
        }
      }
    }
    if (glowRef.current && glowRef.current.visible) {
      glowRef.current.material.opacity = 0.12 + 0.07 * Math.sin(state.clock.elapsedTime * 4);
    }

    // 2) Throttled work (~every 200ms): label culling + code panel trigger.
    accRef.current += delta;
    if (accRef.current < LABEL_INTERVAL) return;
    accRef.current = 0;

    const px = playerState.x;
    const pz = playerState.z;
    const near = [];
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const dx = (b.x || 0) - px;
      const dz = (b.z || 0) - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 < LABEL_RADIUS_SQ) near.push([d2, b]);
    }
    near.sort((a, b) => a[0] - b[0]);
    const chosen = near
      .slice(0, LABEL_MAX)
      .map(([d2, b]) => ({ building: b, top: idToTop.get(b.id) || 4, d2 }));
    const key = chosen
      .map((e) => e.building.id)
      .sort()
      .join('|');
    if (key !== labelKeyRef.current) {
      labelKeyRef.current = key;
      setNearLabels(chosen);
    }

    const wantPanel =
      fid != null && playerState.focusedDistance <= PANEL_RADIUS && idToBuilding.has(fid)
        ? fid
        : null;
    if (wantPanel !== panelIdRef.current) {
      panelIdRef.current = wantPanel;
      setPanelId(wantPanel);
    }
  });

  const panelBuilding = panelId != null ? idToBuilding.get(panelId) : null;

  return (
    <group>
      {/* Whole city: a handful of instanced draw calls (one per block
          material + one for roof trim + one for window glass). */}
      {meshes.map((m) => (
        <primitive key={m.uuid} object={m} />
      ))}

      {/* Focus highlight shell (position/scale mutated imperatively) */}
      <mesh ref={glowRef} visible={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial
          color="#ffffff"
          transparent
          opacity={0.14}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Distance-culled file-name labels (billboarded, scaled with
          distance, with a dark backing plate so they read against sky). */}
      {nearLabels.map(({ building: b, top, d2 }) => {
        const dist = Math.sqrt(d2);
        const fontSize = Math.min(0.9, Math.max(0.32, dist * 0.026));
        const name = b.name || b.id || '';
        const plateW = Math.max(1.4, name.length * fontSize * 0.6);
        return (
          <Billboard key={b.id} position={[b.x || 0, top + 1, b.z || 0]}>
            <mesh position={[0, 0, -0.01]}>
              <planeGeometry args={[plateW, fontSize * 1.7]} />
              <meshBasicMaterial
                color="#1a140b"
                transparent
                opacity={0.42}
                depthWrite={false}
              />
            </mesh>
            <Text
              fontSize={fontSize}
              color="#fff6e0"
              anchorX="center"
              anchorY="middle"
              outlineWidth={fontSize * 0.07}
              outlineColor="#1a140b"
              maxWidth={12}
            >
              {name}
            </Text>
          </Billboard>
        );
      })}

      {/* Code panel for the ONE focused, close-enough building */}
      {panelBuilding ? <CodePanel building={panelBuilding} fetchCode={fetchCode} /> : null}
    </group>
  );
}
