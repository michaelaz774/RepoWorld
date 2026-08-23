/**
 * Roads — the voxel street network.
 *
 * VOXEL ART DIRECTION (see scratchpad/VOXEL.md supersedes the realism direction in
 * BRIEF2.md): roads are paved by filling grid cells with stone/gravel blocks rather than
 * drawing smooth asphalt quads. Everything here shares the ONE unit-cube BoxGeometry
 * (with baked per-face shading) exported by `./Ground.jsx`, so the whole world — ground and
 * roads alike — draws from a single shared geometry, per the brief.
 *
 * Layers, all grid-snapped to `computeRoadCells` (imported from Ground.jsx so the two files
 * can never disagree about which cells are road, which avoids double-placing a ground block
 * under a road block):
 * - Road surface: one InstancedMesh, one block per road cell, top flush with y=0 (same level
 *   as the ground blocks), tinted per `kind` (arterial vs street) via instanceColor.
 * - Sidewalks/curbs: a halo of cells adjacent to (but not part of) the road cell set — found
 *   by checking each road cell's 4 grid neighbours, deduped with a Set/Map keyed on "x|z" so
 *   corners and intersections never get double-placed — raised a half block (0.5) so the
 *   player visibly steps up onto them.
 * - Lane markings: a thin thin slab sitting on *top* of the road blocks (not coplanar with
 *   them, so no z-fight is even possible): a dashed line of lighter blocks down the centre of
 *   arterial segments, and an alternating light/dark checkerboard patch near every junction
 *   (found by counting shared segment endpoints) standing in for crosswalk stripes. Both
 *   accumulate into one deduped map before instancing so a cell is never lit twice.
 *
 * Determinism: no Math.random anywhere; the only "random" look (texture speckle) comes from
 * `mulberry32`/`hashStr` in Ground.jsx, seeded with fixed strings.
 * Performance: nothing here touches useFrame — it's all static geometry built once in
 * useMemo, merged into 3 InstancedMeshes total for the entire street network.
 */
import { useMemo } from 'react';
import * as THREE from 'three';
import {
  getVoxelGeometry,
  getFlatQuadGeometry,
  computeRoadCells,
  cellKey,
  makePixelTexture,
  hashStr,
  mulberry32,
} from './Ground.jsx';

/* ------------------------------------------------------------------ */
/* Materials (built once, shared by every instance in a bucket).       */
/* ------------------------------------------------------------------ */

let _roadTex = null;
let _sidewalkTex = null;

/** Asphalt with a hint of worn-patch mottling (deterministic darker blotches), not just
 *  uniform speckle — reads as a used road instead of flat grey plastic. */
function getRoadTexture() {
  if (_roadTex) return _roadTex;
  if (typeof document === 'undefined') return null;
  const size = 16;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  const base = new THREE.Color('#d6d6d2');
  const rand = mulberry32(hashStr('road-surface'));
  const tmp = new THREE.Color();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let t = (rand() - 0.5) * 0.09;
      // sparse worn/oil-stain blotches, darker and slightly desaturated
      if (rand() < 0.05) t -= 0.22;
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
  _roadTex = tex;
  return _roadTex;
}
function getSidewalkTexture() {
  if (!_sidewalkTex) _sidewalkTex = makePixelTexture('#e2ddc9', 0.08, 'road-sidewalk', 16);
  return _sidewalkTex;
}

let _roadMat = null;
let _sidewalkMat = null;
let _markMat = null;
function getRoadMat() {
  if (!_roadMat) {
    _roadMat = new THREE.MeshLambertMaterial({ map: getRoadTexture(), vertexColors: true });
  }
  return _roadMat;
}
function getSidewalkMat() {
  if (!_sidewalkMat) {
    _sidewalkMat = new THREE.MeshLambertMaterial({
      map: getSidewalkTexture(),
      color: '#cdc7b4',
      vertexColors: true,
    });
  }
  return _sidewalkMat;
}
function getMarkMat() {
  if (!_markMat) {
    _markMat = new THREE.MeshLambertMaterial({ color: '#f4efd9', vertexColors: true });
  }
  return _markMat;
}

const ARTERIAL_TINT = new THREE.Color('#4d4d54');
const STREET_TINT = new THREE.Color('#736f61');
const WHITE = new THREE.Color('#ffffff');

/* ------------------------------------------------------------------ */
/* Segment normalization (for detail work computeRoadCells' merged map  */
/* can't give us back: per-segment length/orientation for dashes).     */
/* ------------------------------------------------------------------ */

function normalizeSegment(r) {
  if (!r) return null;
  const x1 = Number(r.x1);
  const z1 = Number(r.z1);
  const x2 = Number(r.x2);
  const z2 = Number(r.z2);
  if (![x1, z1, x2, z2].every(Number.isFinite)) return null;
  const width = Math.min(40, Math.max(2, Number(r.width) || 4));
  const kind = r.kind === 'arterial' ? 'arterial' : 'street';
  if (Math.abs(x2 - x1) >= Math.abs(z2 - z1)) {
    return {
      kind,
      orient: 'h',
      axMin: Math.min(x1, x2),
      axMax: Math.max(x1, x2),
      perp: (z1 + z2) / 2,
      x1, z1, x2, z2,
    };
  }
  return {
    kind,
    orient: 'v',
    axMin: Math.min(z1, z2),
    axMax: Math.max(z1, z2),
    perp: (x1 + x2) / 2,
    x1, z1, x2, z2,
  };
}

/** Build one InstancedMesh from {ix,iz[,tint]} cells + a Y placement. Null if empty.
 *  Pass `flat: true` for a cell layer that's flush and contiguous with itself (the road
 *  surface — never shows a side face, same reasoning as Ground.jsx's ground field) to use a
 *  2-triangle top tile instead of a 12-triangle cube. Don't pass it for the sidewalk: its
 *  raised curb riser is a real, visible side face. */
function buildBlocks(cells, material, topY, height, withTint, flat = false) {
  if (!cells.length) return null;
  const geometry = flat ? getFlatQuadGeometry() : getVoxelGeometry();
  const mesh = new THREE.InstancedMesh(geometry, material, cells.length);
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, flat ? 1 : height, 1);
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    pos.set(c.ix + 0.5, flat ? topY : topY - height, c.iz + 0.5);
    m.compose(pos, quat, scale);
    mesh.setMatrixAt(i, m);
    if (withTint) mesh.setColorAt(i, c.tint || WHITE);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  // Pavement receives building/tree shadows but is flat and never worth casting from.
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  return mesh;
}

/* ------------------------------------------------------------------ */
/* Component                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {{layout: import('../lib/types.js').CityLayout|null}} props
 */
export default function Roads({ layout }) {
  const roads = layout?.roads;

  const built = useMemo(() => {
    if (!Array.isArray(roads) || roads.length === 0) return null;
    const roadCellMap = computeRoadCells(roads);
    if (roadCellMap.size === 0) return null;

    // --- road surface blocks, tinted by kind ---
    const roadCells = [];
    for (const [key, info] of roadCellMap) {
      const [ixs, izs] = key.split('|');
      roadCells.push({
        ix: parseInt(ixs, 10),
        iz: parseInt(izs, 10),
        tint: info.kind === 'arterial' ? ARTERIAL_TINT : STREET_TINT,
      });
    }

    // --- sidewalk halo: grid neighbours of road cells that aren't themselves road ---
    const sidewalkMap = new Map();
    for (const key of roadCellMap.keys()) {
      const [ixs, izs] = key.split('|');
      const ix = parseInt(ixs, 10);
      const iz = parseInt(izs, 10);
      const neighbors = [
        [ix + 1, iz], [ix - 1, iz], [ix, iz + 1], [ix, iz - 1],
      ];
      for (const [nx, nz] of neighbors) {
        const nk = cellKey(nx, nz);
        if (!roadCellMap.has(nk) && !sidewalkMap.has(nk)) {
          sidewalkMap.set(nk, { ix: nx, iz: nz });
        }
      }
    }
    const sidewalkCells = Array.from(sidewalkMap.values());

    // --- normalized segments, for dashed centerlines + junction crosswalks ---
    const segs = roads.map(normalizeSegment).filter(Boolean);

    const lightMarks = new Map(); // dedup: a cell is only ever lit once

    // dashed centerline down arterial segments
    for (const s of segs) {
      if (s.kind !== 'arterial') continue;
      const ax0 = Math.floor(s.axMin);
      const ax1 = Math.floor(s.axMax - 1e-6);
      const row = Math.floor(s.perp);
      for (let a = ax0; a <= ax1; a++) {
        if ((a - ax0) % 2 !== 0) continue;
        const ix = s.orient === 'h' ? a : row;
        const iz = s.orient === 'h' ? row : a;
        const k = cellKey(ix, iz);
        if (roadCellMap.has(k) && !lightMarks.has(k)) lightMarks.set(k, { ix, iz });
      }
    }

    // crosswalk-style checkerboard patch near every junction (>=2 segments sharing an
    // endpoint), found without any per-cell scan of all roads — just endpoint counting.
    const endpoints = new Map();
    for (const r of roads) {
      const x1 = Number(r.x1), z1 = Number(r.z1), x2 = Number(r.x2), z2 = Number(r.z2);
      if (![x1, z1, x2, z2].every(Number.isFinite)) continue;
      for (const [ex, ez] of [[x1, z1], [x2, z2]]) {
        const k = Math.round(ex) + '|' + Math.round(ez);
        const e = endpoints.get(k);
        if (e) e.count += 1;
        else endpoints.set(k, { x: ex, z: ez, count: 1 });
      }
    }
    for (const e of endpoints.values()) {
      if (e.count < 2) continue;
      const cix = Math.round(e.x);
      const ciz = Math.round(e.z);
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          const ix = cix + dx;
          const iz = ciz + dz;
          if ((ix + iz) % 2 !== 0) continue;
          const k = cellKey(ix, iz);
          if (roadCellMap.has(k) && !lightMarks.has(k)) lightMarks.set(k, { ix, iz });
        }
      }
    }

    return {
      roadCells,
      sidewalkCells,
      markCells: Array.from(lightMarks.values()),
    };
  }, [roads]);

  const roadMesh = useMemo(
    () => (built ? buildBlocks(built.roadCells, getRoadMat(), 0, 1, true, true) : null),
    [built]
  );
  const sidewalkMesh = useMemo(
    () => (built ? buildBlocks(built.sidewalkCells, getSidewalkMat(), 0.5, 0.5, false) : null),
    [built]
  );
  const markMesh = useMemo(
    () => (built ? buildBlocks(built.markCells, getMarkMat(), 0.12, 0.12, false) : null),
    [built]
  );

  if (!built) return null;

  return (
    <group>
      {roadMesh && <primitive object={roadMesh} />}
      {sidewalkMesh && <primitive object={sidewalkMesh} />}
      {markMesh && <primitive object={markMesh} />}
    </group>
  );
}
