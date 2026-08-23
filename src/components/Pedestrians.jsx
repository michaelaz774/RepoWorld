/**
 * Pedestrians — a crowd of blocky, Minecraft-style people walking the sidewalk
 * graph (`layout.paths`; see PathNode/CityLayout in src/lib/types.js).
 *
 * Voxel art direction (supersedes any earlier "realistic figure" plan):
 * - A person is 6 boxes (head, torso, 2 arms, 2 legs), chunky proportions,
 *   flat saturated clothing colors, faked per-face brightness — no PBR shine,
 *   no curves.
 * - ONE THREE.InstancedMesh holds every body part of every agent (instance
 *   count = agentCount * 6), sharing ONE unit BoxGeometry singleton and ONE
 *   MeshLambertMaterial singleton. A second, smaller InstancedMesh (one
 *   instance per agent) draws a flat dark "shadow" box under each person's
 *   feet — still boxes, no soft/circular decals.
 * - Per-face shading is baked once into the shared geometry's vertex-color
 *   attribute (top brightest, sides medium, front/back darkest); the actual
 *   per-agent clothing/skin tint is the InstancedMesh's per-instance color.
 *   three's built-in color chunk multiplies vertexColor * instanceColor for
 *   free — see color_vertex.glsl.js — so no custom shader is needed.
 * - The classic stiff Minecraft limb swing (arms/legs rotating about their
 *   top pivot, opposite phase, driven by distance walked) is computed with
 *   reused scratch Quaternion/Vector3/Matrix4 objects in one useFrame; zero
 *   allocation per frame, one `needsUpdate` per mesh per frame.
 * - Agents beyond CULL_DIST of the player are skipped for matrix writes this
 *   frame (their last-drawn matrix just stays put) so a large crowd stays cheap.
 *
 * Simulation itself (crowd.js) is pure and shared unchanged from the
 * non-voxel plan: this component only decides how to *draw* each agent.
 */
import * as THREE from 'three';
import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { createCrowd, stepCrowd, agentPosition } from '../lib/crowd.js';
import { playerState } from '../lib/playerState.js';

const CULL_DIST = 140;
const CULL_DIST_SQ = CULL_DIST * CULL_DIST;

// Body part sub-instance indices (6 per agent).
const HEAD = 0;
const TORSO = 1;
const ARM_L = 2;
const ARM_R = 3;
const LEG_L = 4;
const LEG_R = 5;
const PARTS_PER_AGENT = 6;

// Base blocky proportions (world units), roughly 1.8 tall overall.
const LEG_H = 0.72;
const LEG_W = 0.25;
const LEG_D = 0.25;
const TORSO_H = 0.65;
const TORSO_W = 0.5;
const TORSO_D = 0.28;
const ARM_H = 0.68;
const ARM_W = 0.22;
const ARM_D = 0.22;
const HEAD_SIZE = 0.45;

const HIP_Y = LEG_H;
const SHOULDER_Y = LEG_H + TORSO_H;
const TORSO_CENTER_Y = LEG_H + TORSO_H / 2;
const HEAD_CENTER_Y = SHOULDER_Y + HEAD_SIZE / 2;
const LEG_SPREAD = (TORSO_W - LEG_W) / 2;
const ARM_SPREAD = TORSO_W / 2 + ARM_W / 2;

// Static per-part layout: [pivotX, pivotY, halfLen, dimX, dimY, dimZ]
// halfLen = 0 for parts that don't hang/swing (head, torso) — the "pivot" is
// then just their own center and swing angle is always 0 for them.
const PART_LAYOUT = [
  [0, HEAD_CENTER_Y, 0, HEAD_SIZE, HEAD_SIZE, HEAD_SIZE], // HEAD
  [0, TORSO_CENTER_Y, 0, TORSO_W, TORSO_H, TORSO_D], // TORSO
  [-ARM_SPREAD, SHOULDER_Y, ARM_H / 2, ARM_W, ARM_H, ARM_D], // ARM_L
  [ARM_SPREAD, SHOULDER_Y, ARM_H / 2, ARM_W, ARM_H, ARM_D], // ARM_R
  [-LEG_SPREAD, HIP_Y, LEG_H / 2, LEG_W, LEG_H, LEG_D], // LEG_L
  [LEG_SPREAD, HIP_Y, LEG_H / 2, LEG_W, LEG_H, LEG_D], // LEG_R
];

const SWING_AMP = 0.7; // radians, base leg swing amplitude
const ARM_SWING_RATIO = 0.85;

// Flat, saturated, "everyday clothing" voxel palette + skin tones.
const SKIN_TONES = ['#f2c9a1', '#e0ac69', '#c68642', '#8d5524', '#4a2c17'];
const SHIRT_COLORS = [
  '#c0392b', '#2980b9', '#27ae60', '#e67e22', '#8e44ad',
  '#d4af17', '#16a085', '#7f8c8d', '#34495e', '#d35400',
];
const TROUSER_COLORS = ['#2c3e50', '#34495e', '#4a3728', '#5d4037', '#37474f', '#263238'];

/** Deterministic [0,1) from (index, salt) — mulberry32-style, no Math.random. */
function hash01(i, salt) {
  let h = (Math.imul(i + 1, 2654435761) ^ Math.imul(salt + 1, 0x85ebca6b)) | 0;
  h = (h + 0x6d2b79f5) | 0;
  let t = h;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function pick(list, frac) {
  const idx = Math.floor(frac * list.length);
  return list[idx < list.length ? idx : list.length - 1];
}

/* ------------------------------------------------------------------ */
/* Shared singletons                                                   */
/* ------------------------------------------------------------------ */

let sharedBodyGeometry = null;
/** Unit box (centered, -0.5..0.5) with baked per-face brightness vertex
 * colors: top brightest, +X/-X sides medium, front/back (+Z/-Z) darkest. */
function getBodyGeometry() {
  if (sharedBodyGeometry) return sharedBodyGeometry;
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const count = geo.attributes.position.count; // 24 (4 verts x 6 faces, no segments)
  const colors = new Float32Array(count * 3);
  // Face order for a default (1-segment) BoxGeometry: +X, -X, +Y, -Y, +Z, -Z.
  const faceBrightness = [0.82, 0.82, 1.0, 0.55, 0.7, 0.7];
  for (let f = 0; f < 6 && f * 4 < count; f++) {
    const b = faceBrightness[f];
    for (let v = 0; v < 4; v++) {
      const o = (f * 4 + v) * 3;
      colors[o] = b;
      colors[o + 1] = b;
      colors[o + 2] = b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  sharedBodyGeometry = geo;
  return geo;
}

let sharedBodyMaterial = null;
function getBodyMaterial() {
  if (!sharedBodyMaterial) {
    sharedBodyMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  }
  return sharedBodyMaterial;
}

let sharedShadowGeometry = null;
function getShadowGeometry() {
  if (!sharedShadowGeometry) sharedShadowGeometry = new THREE.BoxGeometry(1, 1, 1);
  return sharedShadowGeometry;
}

let sharedShadowMaterial = null;
function getShadowMaterial() {
  if (!sharedShadowMaterial) {
    sharedShadowMaterial = new THREE.MeshBasicMaterial({
      color: '#000000',
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    });
  }
  return sharedShadowMaterial;
}

/* ------------------------------------------------------------------ */
/* Scratch objects reused every frame — zero allocation in useFrame    */
/* ------------------------------------------------------------------ */

const _yawQuat = new THREE.Quaternion();
const _swingQuat = new THREE.Quaternion();
const _combined = new THREE.Quaternion();
const _axisX = new THREE.Vector3(1, 0, 0);
const _axisY = new THREE.Vector3(0, 1, 0);
const _pivotLocal = new THREE.Vector3();
const _pivotWorld = new THREE.Vector3();
const _hangOffset = new THREE.Vector3();
const _center = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _shadowPos = new THREE.Vector3();
const _shadowScale = new THREE.Vector3();
const _posOut = { x: 0, z: 0, angle: 0 };
const _swingByPart = new Float64Array(PARTS_PER_AGENT); // reused, never reallocated

/**
 * @param {{layout?: import('../lib/types.js').CityLayout|null, count?: number}} props
 */
export default function Pedestrians({ layout, count = 120 }) {
  const paths = layout && Array.isArray(layout.paths) ? layout.paths : [];

  // Build the crowd + both instanced meshes together, exactly like
  // Buildings.jsx: colors are baked in at construction time (they never
  // change frame to frame), matrices are written imperatively in useFrame.
  const { crowd, bodyMesh, shadowMesh } = useMemo(() => {
    const c = createCrowd(paths, count);
    const n = c.count;

    const bMesh = new THREE.InstancedMesh(getBodyGeometry(), getBodyMaterial(), Math.max(n * PARTS_PER_AGENT, 1));
    bMesh.count = n * PARTS_PER_AGENT;
    bMesh.frustumCulled = false;

    const sMesh = new THREE.InstancedMesh(getShadowGeometry(), getShadowMaterial(), Math.max(n, 1));
    sMesh.count = n;
    sMesh.frustumCulled = false;

    const skin = new THREE.Color();
    const shirt = new THREE.Color();
    const trouser = new THREE.Color();
    for (let i = 0; i < n; i++) {
      skin.set(pick(SKIN_TONES, hash01(i, 101)));
      shirt.set(pick(SHIRT_COLORS, hash01(i, 102)));
      trouser.set(pick(TROUSER_COLORS, hash01(i, 103)));
      const base = i * PARTS_PER_AGENT;
      bMesh.setColorAt(base + HEAD, skin);
      bMesh.setColorAt(base + TORSO, shirt);
      bMesh.setColorAt(base + ARM_L, shirt);
      bMesh.setColorAt(base + ARM_R, shirt);
      bMesh.setColorAt(base + LEG_L, trouser);
      bMesh.setColorAt(base + LEG_R, trouser);
    }
    if (bMesh.instanceColor) bMesh.instanceColor.needsUpdate = true;

    return { crowd: c, bodyMesh: bMesh, shadowMesh: sMesh };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paths, count]);

  useEffect(() => {
    return () => {
      bodyMesh.dispose();
      shadowMesh.dispose();
    };
  }, [bodyMesh, shadowMesh]);

  const agentCount = crowd.count;

  useFrame((_state, delta) => {
    if (agentCount === 0) return;
    stepCrowd(crowd, paths, delta);

    const px = playerState.x;
    const pz = playerState.z;

    for (let i = 0; i < agentCount; i++) {
      agentPosition(crowd, i, _posOut);
      const dx = _posOut.x - px;
      const dz = _posOut.z - pz;
      if (dx * dx + dz * dz > CULL_DIST_SQ) continue; // leave last matrix in place

      const heightScale = crowd.heightScale[i];
      const buildScale = crowd.buildScale[i];
      const phase = crowd.phase[i];
      const speedT = (crowd.speed[i] - 1.2) / 0.4; // 0..1 across the human speed range
      const amp = SWING_AMP * (0.82 + 0.3 * speedT);
      const swing = amp * Math.sin(phase);
      // HEAD, TORSO stay at 0; ARM_L/ARM_R/LEG_L/LEG_R below (see PART index consts).
      _swingByPart[HEAD] = 0;
      _swingByPart[TORSO] = 0;
      _swingByPart[ARM_L] = -swing * ARM_SWING_RATIO;
      _swingByPart[ARM_R] = swing * ARM_SWING_RATIO;
      _swingByPart[LEG_L] = swing;
      _swingByPart[LEG_R] = -swing;

      _yawQuat.setFromAxisAngle(_axisY, _posOut.angle);
      const base = i * PARTS_PER_AGENT;

      for (let p = 0; p < PARTS_PER_AGENT; p++) {
        const layoutRow = PART_LAYOUT[p];
        const pivotX = layoutRow[0] * buildScale;
        const pivotY = layoutRow[1] * heightScale;
        const halfLen = layoutRow[2] * heightScale;
        const dimX = layoutRow[3] * buildScale;
        const dimY = layoutRow[4] * heightScale;
        const dimZ = layoutRow[5] * buildScale;

        const angle = _swingByPart[p];
        _swingQuat.setFromAxisAngle(_axisX, angle);
        _combined.multiplyQuaternions(_yawQuat, _swingQuat);

        // Pivot point in world space: person position + yaw-rotated local offset.
        _pivotLocal.set(pivotX, pivotY, 0);
        _pivotWorld.copy(_pivotLocal).applyQuaternion(_yawQuat);
        _pivotWorld.x += _posOut.x;
        _pivotWorld.z += _posOut.z;

        // Box center hangs `halfLen` below the pivot, in the swung+yawed frame
        // (0 for head/torso, whose pivot IS their center).
        _hangOffset.set(0, -halfLen, 0).applyQuaternion(_combined);
        _center.copy(_pivotWorld).add(_hangOffset);

        _scale.set(dimX, dimY, dimZ);
        _mat.compose(_center, _combined, _scale);
        bodyMesh.setMatrixAt(base + p, _mat);
      }

      _shadowPos.set(_posOut.x, 0.015, _posOut.z);
      _shadowScale.set(0.55 * buildScale, 0.03, 0.35 * buildScale);
      _mat.compose(_shadowPos, _yawQuat, _shadowScale);
      shadowMesh.setMatrixAt(i, _mat);
    }

    bodyMesh.instanceMatrix.needsUpdate = true;
    shadowMesh.instanceMatrix.needsUpdate = true;
  });

  if (!layout || agentCount === 0) return null;

  return (
    <group>
      <primitive object={bodyMesh} />
      <primitive object={shadowMesh} />
    </group>
  );
}
