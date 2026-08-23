/**
 * Ground — the voxel terrain the whole city sits on.
 *
 * VOXEL ART DIRECTION (see scratchpad/VOXEL.md): everything here is 1x1x1 cubes on an
 * integer grid, textured with tiny (8px) nearest-filtered canvas textures and shaded with
 * baked per-face vertex colors (top brightest, sides medium, bottom darkest) instead of PBR.
 *
 * What this file owns:
 * - A shared unit-cube BoxGeometry with baked face-shading vertex colors, exported for reuse
 *   by Roads.jsx (and anything else that wants a voxel block) so the whole world shares ONE
 *   geometry, per the brief.
 * - `computeRoadCells`, a deterministic rasterizer that turns `layout.roads` into the set of
 *   grid cells a road occupies. Exported so Roads.jsx paves exactly those cells and Ground
 *   never places a grass/plaza block underneath one (which would be a coplanar double-place
 *   / z-fight — the one case in this style that still matters).
 * - The block field itself: grass everywhere open, park/plaza/lot paving inside `layout.plots`
 *   and district footprints (tinted per-district, still flat and cheerful, not glowing), and
 *   a single large flat far plane beyond the block field so the horizon reads without an
 *   edge, fading into fog like everything else.
 * - Restyled district labels: a small billboarded "sign" (flat board + text) per district,
 *   replacing the old floating neon holograms.
 *
 * All variation is seeded from fixed strings via `mulberry32`/`hashStr` — no Math.random.
 * Nothing here runs in useFrame; it's all static geometry built once in useMemo.
 */
import { useMemo } from 'react';
import * as THREE from 'three';
import { Billboard, Text } from '@react-three/drei';

/* ------------------------------------------------------------------ */
/* Deterministic hashing (FNV-1a + mulberry32) — no Math.random ever.   */
/* ------------------------------------------------------------------ */

export function hashStr(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tiny (16px default) nearest-filtered canvas texture: a flat base color with deterministic
 *  per-pixel speckle. This is the whole "voxel" texture recipe — crisp, cheap, no mipmaps. */
export function makePixelTexture(baseHex, variance, seedStr, size = 16) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  const base = new THREE.Color(baseHex);
  const rand = mulberry32(hashStr(seedStr));
  const tmp = new THREE.Color();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = (rand() - 0.5) * (variance || 0.12);
      tmp.copy(base).offsetHSL(0, 0, t);
      ctx.fillStyle = `rgb(${Math.round(tmp.r * 255)},${Math.round(tmp.g * 255)},${Math.round(tmp.b * 255)})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * A 3-band ("atlas") nearest-filtered texture for use with the shared voxel geometry's
 * top/side/bottom UV bands (see `getVoxelGeometry`): canvas rows, top to bottom, are
 * [top-face pixels | side-face pixels | bottom-face pixels] stacked in one image so a
 * single draw call still gets a different look per face — the classic "grass block"
 * trick (green top, dirt sides) without any extra materials/draw calls. `paintBand(ctx,
 * y0, size, band)` is called once per band ('top'|'side'|'bottom') to fill a `size x size`
 * square starting at row `y0`; NOT exported outside this module since only Ground.jsx's
 * grass material needs it — everything else stays a plain flat `makePixelTexture`.
 */
function makeAtlasPixelTexture(paintBand, size = 16) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size * 3;
  const ctx = c.getContext('2d');
  paintBand(ctx, 0, size, 'top');
  paintBand(ctx, size, size, 'side');
  paintBand(ctx, size * 2, size, 'bottom');
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping; // never let a face bleed into a neighbouring band
  tex.needsUpdate = true;
  return tex;
}

function speckleFill(ctx, y0, size, baseHex, variance, seedStr) {
  const base = new THREE.Color(baseHex);
  const rand = mulberry32(hashStr(seedStr));
  const tmp = new THREE.Color();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = (rand() - 0.5) * variance;
      tmp.copy(base).offsetHSL(0, 0, t);
      ctx.fillStyle = `rgb(${Math.round(tmp.r * 255)},${Math.round(tmp.g * 255)},${Math.round(tmp.b * 255)})`;
      ctx.fillRect(x, y0 + y, 1, 1);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Shared voxel geometry — ONE BoxGeometry for the entire world.       */
/* Pivoted at its bottom face (spans y:[0,1] at scale 1) so instances  */
/* are placed by (top-of-block, height): position.y = top - height,   */
/* scale.y = height. Face-shading baked as a vertex 'color' attribute: */
/* BoxGeometry's fixed vertex layout is px(0-3) nx(4-7) py(8-11,top)   */
/* ny(12-15,bottom) pz(16-19) nz(20-23) — verified against three 0.185.*/
/* ------------------------------------------------------------------ */

let _voxelGeo = null;
export function getVoxelGeometry() {
  if (_voxelGeo) return _voxelGeo;
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  const count = geo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  const shades = [0.84, 0.8, 1.0, 0.5, 0.74, 0.78]; // px, nx, py(top), ny(bottom), pz, nz
  for (let f = 0; f < 6; f++) {
    const s = shades[f];
    for (let v = 0; v < 4; v++) {
      const i = (f * 4 + v) * 3;
      colors[i] = s;
      colors[i + 1] = s;
      colors[i + 2] = s;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  // Remap V so each face samples its own horizontal band of a stacked 3-row atlas
  // (top band / side band / bottom band, top-to-bottom in the image — see
  // `makeAtlasPixelTexture`). A plain non-atlas texture still looks correct here: every
  // band just samples a different slice of the same flat speckle image, which is
  // indistinguishable from sampling the whole thing. Only materials that actually want a
  // different look per face (grass: green top / dirt sides) need to supply an atlas.
  const uv = geo.attributes.uv;
  if (geo.index && geo.groups && geo.groups.length && uv) {
    const idx = geo.index;
    const BAND = 1 / 3;
    // px, nx, py(top), ny(bottom), pz, nz -> band row index (0=bottom-of-image band, 1=mid, 2=top-of-image band)
    const bandForFace = [1, 1, 2, 0, 1, 1];
    for (const group of geo.groups) {
      const band = bandForFace[group.materialIndex] != null ? bandForFace[group.materialIndex] : 1;
      for (let i = group.start; i < group.start + group.count; i++) {
        const vIdx = idx.getX(i);
        const v0 = uv.getY(vIdx); // 0 or 1 on a fresh BoxGeometry face
        uv.setY(vIdx, band * BAND + v0 * BAND);
      }
    }
    uv.needsUpdate = true;
  }

  _voxelGeo = geo;
  return geo;
}

/* ------------------------------------------------------------------ */
/* Road cell rasterization — shared with Roads.jsx so the two files    */
/* agree exactly on which grid cells belong to the street network.     */
/* ------------------------------------------------------------------ */

export function cellKey(ix, iz) {
  return ix + '|' + iz;
}

/**
 * @param {import('../lib/types.js').RoadSegment[]} roads
 * @returns {Map<string,{kind:'arterial'|'street'}>} grid cell -> road kind (arterial wins ties)
 */
export function computeRoadCells(roads) {
  const map = new Map();
  if (!Array.isArray(roads)) return map;
  for (const r of roads) {
    if (!r) continue;
    const x1 = Number(r.x1);
    const z1 = Number(r.z1);
    const x2 = Number(r.x2);
    const z2 = Number(r.z2);
    if (![x1, z1, x2, z2].every(Number.isFinite)) continue;
    const width = Math.min(40, Math.max(2, Number(r.width) || 4));
    const kind = r.kind === 'arterial' ? 'arterial' : 'street';
    const halfW = width / 2;
    let xMin, xMax, zMin, zMax;
    if (Math.abs(x2 - x1) >= Math.abs(z2 - z1)) {
      xMin = Math.min(x1, x2);
      xMax = Math.max(x1, x2);
      const zc = (z1 + z2) / 2;
      zMin = zc - halfW;
      zMax = zc + halfW;
    } else {
      zMin = Math.min(z1, z2);
      zMax = Math.max(z1, z2);
      const xc = (x1 + x2) / 2;
      xMin = xc - halfW;
      xMax = xc + halfW;
    }
    const ix0 = Math.floor(xMin);
    const ix1 = Math.floor(xMax - 1e-6);
    const iz0 = Math.floor(zMin);
    const iz1 = Math.floor(zMax - 1e-6);
    if (ix1 - ix0 > 3000 || iz1 - iz0 > 3000) continue; // defensive: skip corrupt data
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const k = cellKey(ix, iz);
        const existing = map.get(k);
        if (!existing || (kind === 'arterial' && existing.kind !== 'arterial')) {
          map.set(k, { kind });
        }
      }
    }
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* Materials (built once, shared across every instance in a bucket).   */
/* MeshLambertMaterial: flat diffuse shading, no PBR shine, no neon.   */
/* ------------------------------------------------------------------ */

let _grassTex = null;
let _plazaTex = null;
let _lotTex = null;

/** Classic voxel grass block: speckled green top with a few darker "blade" pixels,
 *  dirt sides, slightly darker dirt underneath. One atlas texture, one draw call. */
function getGrassTexture() {
  if (_grassTex) return _grassTex;
  _grassTex = makeAtlasPixelTexture((ctx, y0, size, band) => {
    if (band === 'top') {
      speckleFill(ctx, y0, size, '#5fa93c', 0.14, 'ground-grass-top');
      // deterministic blade flecks: a handful of darker/lighter single pixels
      const rand = mulberry32(hashStr('ground-grass-blades'));
      const blade = new THREE.Color('#3f7d27');
      const bladeLight = new THREE.Color('#8fd35f');
      for (let i = 0; i < Math.round(size * size * 0.22); i++) {
        const x = Math.floor(rand() * size);
        const y = Math.floor(rand() * size);
        const c = rand() < 0.5 ? blade : bladeLight;
        ctx.fillStyle = `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
        ctx.fillRect(x, y0 + y, 1, 1);
      }
    } else if (band === 'side') {
      speckleFill(ctx, y0, size, '#8a6b46', 0.16, 'ground-grass-side');
      // a thin green fringe along the very top row of the side band (grass lip hanging over dirt)
      const fringe = new THREE.Color('#4f8f30');
      for (let x = 0; x < size; x++) {
        ctx.fillStyle = `rgb(${Math.round(fringe.r * 255)},${Math.round(fringe.g * 255)},${Math.round(fringe.b * 255)})`;
        ctx.fillRect(x, y0, 1, Math.max(1, Math.round(size * 0.16)));
      }
    } else {
      speckleFill(ctx, y0, size, '#6e5335', 0.14, 'ground-grass-bottom');
    }
  }, 16);
  return _grassTex;
}
function getPlazaTexture() {
  if (!_plazaTex) _plazaTex = makePixelTexture('#b9b2a0', 0.14, 'ground-plaza', 16);
  return _plazaTex;
}
function getLotTexture() {
  if (!_lotTex) _lotTex = makePixelTexture('#9c8354', 0.14, 'ground-lot', 16);
  return _lotTex;
}

let _grassMat = null;
let _parkMat = null;
let _plazaMat = null;
let _lotMat = null;
function getGrassMat() {
  if (!_grassMat) {
    _grassMat = new THREE.MeshLambertMaterial({ map: getGrassTexture(), vertexColors: true });
  }
  return _grassMat;
}
function getParkMat() {
  if (!_parkMat) {
    _parkMat = new THREE.MeshLambertMaterial({
      map: getGrassTexture(),
      color: '#bff0a8',
      vertexColors: true,
    });
  }
  return _parkMat;
}
function getPlazaMat() {
  if (!_plazaMat) {
    _plazaMat = new THREE.MeshLambertMaterial({ map: getPlazaTexture(), vertexColors: true });
  }
  return _plazaMat;
}
function getLotMat() {
  if (!_lotMat) {
    _lotMat = new THREE.MeshLambertMaterial({ map: getLotTexture(), vertexColors: true });
  }
  return _lotMat;
}

/* ------------------------------------------------------------------ */
/* Flat top-only tiles for the ground field (perf).                    */
/*                                                                      */
/* The ground field is one continuous flat layer: every grass/park/     */
/* plaza/lot cell sits at the exact same height as its neighbours, so a */
/* side or bottom face is NEVER visible anywhere in it — the only place */
/* the world actually shows a vertical ground riser is the sidewalk     */
/* curb (Roads.jsx), which still uses the full voxel cube for that.     */
/* Rendering a full BoxGeometry (12 triangles) per ground cell was, at   */
/* city scale (tens of thousands of cells), the single heaviest thing   */
/* in the entire scene — measured at ~991K triangles overall, with this */
/* field responsible for the large majority of it. A single top-facing  */
/* quad (2 triangles) looks IDENTICAL from every angle a player can      */
/* actually reach here and cuts each cell's cost by ~83%.               */
/* ------------------------------------------------------------------ */

let _flatQuadGeo = null;
/** Exported so Roads.jsx can flatten its own flush, contiguous road-surface cells the same
 *  way (never used for the raised sidewalk curb, which needs a real cube side face). */
export function getFlatQuadGeometry() {
  if (_flatQuadGeo) return _flatQuadGeo;
  const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const count = geo.attributes.position.count;
  const colors = new Float32Array(count * 3).fill(1.0); // always the brightest "top face" shade
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  _flatQuadGeo = geo;
  return geo;
}

let _flatQuadAtlasGeo = null;
/** Same flat tile, UV-remapped into the top band of the grass atlas texture (see
 *  `makeAtlasPixelTexture`) — used by grass/park, whose material samples that atlas. */
function getFlatQuadAtlasGeometry() {
  if (_flatQuadAtlasGeo) return _flatQuadAtlasGeo;
  const geo = getFlatQuadGeometry().clone();
  const uv = geo.attributes.uv;
  const BAND = 1 / 3;
  for (let i = 0; i < uv.count; i++) {
    uv.setY(i, 2 * BAND + uv.getY(i) * BAND);
  }
  uv.needsUpdate = true;
  _flatQuadAtlasGeo = geo;
  return geo;
}

/** District color, softened into a flat cheerful pastel for its plaza paving tint.
 *  Some districts carry very dark/near-black colors (unset data, or just a dark language
 *  tint) — a plain lerp-toward-white doesn't rescue those (40% of near-black is still
 *  near-black), and a plaza floor that dark reads as a dirt/mud patch that clashes hard
 *  with the grass around it. Clamping in HSL space instead guarantees the paving always
 *  stays a light, flat pastel — cheerful and legible in any daylight, per the art
 *  direction — no matter how dark or saturated the source district color is. */
const WHITE = new THREE.Color('#ffffff');
const _hsl = { h: 0, s: 0, l: 0 };
function districtTint(color) {
  const c = new THREE.Color(color || '#9a9488');
  c.getHSL(_hsl);
  c.setHSL(_hsl.h, Math.min(_hsl.s, 0.45), Math.max(_hsl.l, 0.74));
  return c;
}

/** Build one InstancedMesh from a flat list of {ix, iz[, tint]} cells. Returns null if empty.
 *  `geometry` defaults to the flat top-only tile (see above) — pass the atlas variant for
 *  grass/park, which sample the banded grass texture. */
function buildInstancedBlocks(cells, material, withTint, geometry) {
  if (!cells.length) return null;
  const mesh = new THREE.InstancedMesh(geometry || getFlatQuadGeometry(), material, cells.length);
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    pos.set(cell.ix + 0.5, 0, cell.iz + 0.5); // the tile's own plane IS the top face
    m.compose(pos, quat, scale);
    mesh.setMatrixAt(i, m);
    if (withTint) mesh.setColorAt(i, cell.tint || WHITE);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false; // one draw call for the whole field; cheap either way
  // Ground is a big receiver (building shadows land on it) but never a caster —
  // it's flat, casting from it onto itself would be a no-op that only costs frame time.
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  return mesh;
}

/* ------------------------------------------------------------------ */
/* Component                                                            */
/* ------------------------------------------------------------------ */

const MARGIN = 14; // block field extends this far past the city bounds
const MAX_SPAN = 420; // hard cap on block-field side length (perf safety net)

/**
 * @param {{layout: import('../lib/types.js').CityLayout|null}} props
 */
export default function Ground({ layout }) {
  const bounds = layout?.bounds;
  const districts = useMemo(
    () => (Array.isArray(layout?.districts) ? layout.districts.filter(Boolean) : []),
    [layout]
  );
  const plots = useMemo(
    () => (Array.isArray(layout?.plots) ? layout.plots.filter(Boolean) : []),
    [layout]
  );
  const roads = layout?.roads;

  const roadCells = useMemo(() => computeRoadCells(roads), [roads]);

  const field = useMemo(() => {
    if (!bounds || !Number.isFinite(bounds.minX) || !Number.isFinite(bounds.maxX)) return null;

    let minX = Math.floor(bounds.minX - MARGIN);
    let maxX = Math.ceil(bounds.maxX + MARGIN);
    let minZ = Math.floor(bounds.minZ - MARGIN);
    let maxZ = Math.ceil(bounds.maxZ + MARGIN);
    if (maxX - minX > MAX_SPAN) {
      const c = (minX + maxX) / 2;
      minX = Math.floor(c - MAX_SPAN / 2);
      maxX = Math.ceil(c + MAX_SPAN / 2);
    }
    if (maxZ - minZ > MAX_SPAN) {
      const c = (minZ + maxZ) / 2;
      minZ = Math.floor(c - MAX_SPAN / 2);
      maxZ = Math.ceil(c + MAX_SPAN / 2);
    }

    const distRects = districts.map((d) => ({
      x0: (d.x || 0) - (d.w || 10) / 2,
      x1: (d.x || 0) + (d.w || 10) / 2,
      z0: (d.z || 0) - (d.d || 10) / 2,
      z1: (d.z || 0) + (d.d || 10) / 2,
      tint: districtTint(d.color),
    }));
    const plotRects = plots.map((p) => ({
      x0: (p.x || 0) - (p.w || 6) / 2,
      x1: (p.x || 0) + (p.w || 6) / 2,
      z0: (p.z || 0) - (p.d || 6) / 2,
      z1: (p.z || 0) + (p.d || 6) / 2,
      kind: p.kind,
    }));

    const grass = [];
    const park = [];
    const plaza = [];
    const lot = [];

    for (let ix = minX; ix < maxX; ix++) {
      const cx = ix + 0.5;
      for (let iz = minZ; iz < maxZ; iz++) {
        const cz = iz + 0.5;
        if (roadCells.has(cellKey(ix, iz))) continue;

        let hit = false;
        for (let i = 0; i < plotRects.length; i++) {
          const r = plotRects[i];
          if (cx >= r.x0 && cx <= r.x1 && cz >= r.z0 && cz <= r.z1) {
            if (r.kind === 'park') park.push({ ix, iz });
            else if (r.kind === 'lot') lot.push({ ix, iz });
            else plaza.push({ ix, iz, tint: null });
            hit = true;
            break;
          }
        }
        if (hit) continue;

        for (let i = 0; i < distRects.length; i++) {
          const r = distRects[i];
          if (cx >= r.x0 && cx <= r.x1 && cz >= r.z0 && cz <= r.z1) {
            plaza.push({ ix, iz, tint: r.tint });
            hit = true;
            break;
          }
        }
        if (!hit) grass.push({ ix, iz });
      }
    }

    const span = Math.max(maxX - minX, maxZ - minZ);
    const cx0 = (minX + maxX) / 2;
    const cz0 = (minZ + maxZ) / 2;

    return { grass, park, plaza, lot, cx0, cz0, span };
  }, [bounds, districts, plots, roadCells]);

  const grassMesh = useMemo(
    () => buildInstancedBlocks(field?.grass || [], getGrassMat(), false, getFlatQuadAtlasGeometry()),
    [field]
  );
  const parkMesh = useMemo(
    () => buildInstancedBlocks(field?.park || [], getParkMat(), false, getFlatQuadAtlasGeometry()),
    [field]
  );
  const plazaMesh = useMemo(
    () => buildInstancedBlocks(field?.plaza || [], getPlazaMat(), true, getFlatQuadGeometry()),
    [field]
  );
  const lotMesh = useMemo(
    () => buildInstancedBlocks(field?.lot || [], getLotMat(), false, getFlatQuadGeometry()),
    [field]
  );

  if (!field) return null;

  // Horizon: one big flat plane, tucked a hair below the block tops so its edge
  // disappears under the block field's outer rim instead of showing a seam, then
  // fading into the fog set by SkyEnvironment (default material fog=true handles this).
  const horizonSize = Math.max(1400, field.span * 4);

  return (
    <group>
      {grassMesh && <primitive object={grassMesh} />}
      {parkMesh && <primitive object={parkMesh} />}
      {plazaMesh && <primitive object={plazaMesh} />}
      {lotMesh && <primitive object={lotMesh} />}

      <mesh
        position={[field.cx0, -0.05, field.cz0]}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow={false}
      >
        <planeGeometry args={[horizonSize, horizonSize]} />
        <meshLambertMaterial color="#5fa93c" />
      </mesh>

      {districts.map((d) => (
        <DistrictSign key={d.name} district={d} />
      ))}
    </group>
  );
}

/** A small blocky "sign" standing at a district's center: a flat board + text, always
 *  facing the player (Billboard), styled like in-world signage rather than a hologram. */
function DistrictSign({ district: d }) {
  const label = d.name === '/' ? 'root' : d.name;
  const fontSize = Math.min(1.1, Math.max(0.55, (d.w || 10) / 14));
  return (
    <Billboard position={[d.x || 0, 2.1, d.z || 0]}>
      <mesh>
        <planeGeometry args={[fontSize * label.length * 0.62 + 0.6, fontSize + 0.5]} />
        <meshBasicMaterial color="#7a5230" />
      </mesh>
      <Text
        position={[0, 0, 0.02]}
        fontSize={fontSize}
        color="#fdf3d8"
        outlineWidth={fontSize * 0.06}
        outlineColor="#3a2412"
        anchorX="center"
        anchorY="middle"
      >
        {label}
      </Text>
    </Billboard>
  );
}
