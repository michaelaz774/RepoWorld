/**
 * Bugs — voxel critters that crawl the streets near the buildings they affect.
 *
 * VOXEL ART DIRECTION (scratchpad/VOXEL.md): every bug is 7 boxes (abdomen,
 * thorax, head, 4 stubby legs) sharing the world's ONE unit block geometry
 * (`getVoxelGeometry()` from Ground.jsx, which bakes per-face brightness as
 * vertex colors — no PBR, no shading textures needed) packed into a SINGLE
 * `THREE.InstancedMesh` — one draw call for every bug's body AND legs
 * together. A second small instanced mesh handles the short-lived
 * cube-particle burst on death. A THIRD instanced mesh draws one thin red
 * "beacon" column per living bug — a Minecraft-beacon-style shaft rising well
 * above the tallest building so bugs are findable from anywhere in the city
 * without hunting for small creatures at street level; it flares briefly and
 * vanishes as its bug dies, and the crosshair-targeted bug's column is
 * brighter/thicker/pulsing so the player can confirm what they're about to
 * deploy on. A single extra (non-instanced) box is the pulsing "targeted"
 * marker cube. Draw calls: 4, flat regardless of bug count.
 *
 * Flat, saturated per-severity color (amber -> angry dark red) is applied as
 * per-instance `instanceColor`, multiplying the baked face-shading vertex
 * colors — same recipe Ground.jsx uses for its district-tinted plaza tiles.
 *
 * SIMULATION: this component is a PURE READER of `chase`. The integrator
 * (Scene.jsx) owns calling `stepChase` / draining kill events; we only ever
 * animate off whatever `chase` currently holds. If `chase` is null (or has no
 * bugs) we render nothing rather than fabricate/step our own simulation.
 *
 * Zero allocation in the frame loop: every Vector3/Quaternion/Matrix4/Color
 * scratch object and the per-bug-part offset table are module-level
 * singletons, reused every write. The only per-frame array walks are over
 * fixed-size structures (bugs, BODY_PARTS, the particle pool).
 */
import * as THREE from 'three';
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { playerState } from '../lib/playerState.js';
import { getVoxelGeometry, makePixelTexture, hashStr } from './Ground.jsx';

const PARTICLE_SLOTS = 48; // 8 concurrent death bursts x 6 cubes
const PARTICLES_PER_BURST = 6;
const PARTICLE_GRAVITY = 2.6;
const DEATH_DURATION = 0.55; // mirrors chase.js's DEATH_DURATION for the pop curve
const BUG_MAX_SPEED = 3.0;  // mirrors chase.js's BUG_SPEED, for the squash/stretch ramp below
// Chunky-critter readability: scales the whole severity ramp up uniformly (so
// severity-10 stays exactly as much nastier than severity-2 as before) while
// keeping bugs clearly smaller than the ~5-6 unit tall Greptiles.
const BUG_SIZE_MULT = 1.8;

// Distance LOD: beyond this, skip the leg-bob/squash-stretch trig for a bug —
// body position/heading/color still update every frame (so nothing pops when
// it re-enters range), only the cosmetic per-frame animation math is skipped.
const ANIM_CULL_DIST = 90;
const ANIM_CULL_DIST_SQ = ANIM_CULL_DIST * ANIM_CULL_DIST;

// Wayfinding beacon: a thin red column per living bug, tall enough to clear
// the tallest building (types.js: height up to 30) with real margin, so it
// reads over rooftops from anywhere in the city. One InstancedMesh regardless
// of bug count — the only per-bug cost is a matrix + color write already done
// while we're iterating bugs anyway.
const BEACON_HEIGHT = 46;
// Thin reads as a hairline that anti-aliases straight into the sky color from
// any real distance (a rendering limit, independent of blend mode) — wide
// enough to hold its hue at range while still reading as a slender shaft.
const BEACON_WIDTH = 0.7;
const BEACON_TARGET_WIDTH_MULT = 2;
const BEACON_BASE_COLOR = new THREE.Color('#e6140a'); // saturated crimson — distinct from Greptile's green
const BEACON_TARGET_COLOR = new THREE.Color('#ff8a78'); // hot coral-red for the targeted bug
// Fade/thin the column when the camera is standing almost on top of it, so a
// player next to a bug isn't staring into a wall of red.
const BEACON_CLOSE_FADE_DIST = 5;

/* ------------------------------------------------------------------ */
/* Shared singletons                                                   */
/* ------------------------------------------------------------------ */

let _shellTex = null;
function getShellTexture() {
  if (!_shellTex) _shellTex = makePixelTexture('#ffffff', 0.14, 'bug-shell', 8);
  return _shellTex;
}

let _bodyMat = null;
function getBodyMaterial() {
  if (!_bodyMat) {
    _bodyMat = new THREE.MeshLambertMaterial({ color: '#ffffff', map: getShellTexture(), vertexColors: true });
  }
  return _bodyMat;
}

let _particleMat = null;
function getParticleMaterial() {
  if (!_particleMat) {
    _particleMat = new THREE.MeshLambertMaterial({ color: '#ffffff', map: getShellTexture(), vertexColors: true });
  }
  return _particleMat;
}

let _beaconMat = null;
/** Unlit, no depth-write, NORMAL (not additive) blending: additive red over a
 *  bright daytime sky desaturates straight to white/pink, which defeats the
 *  point of a *red* beacon distinct from Greptile's green one — plain alpha
 *  blending keeps the crimson hue solid at any background brightness. */
function getBeaconMaterial() {
  if (!_beaconMat) {
    _beaconMat = new THREE.MeshBasicMaterial({
      color: '#ffffff',
      vertexColors: true,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }
  return _beaconMat;
}

// Fixed local-space layout of the 7 boxes that make up one bug, in "unit bug"
// space (multiplied by the per-bug severity scale at write time). `ly`/`sy`
// are CENTER height + full height; converted to the bottom-pivoted offset
// getVoxelGeometry() expects at write time. x/z are rotated by heading.
const BODY_PARTS = [
  { lx: 0, lz: -0.32, ly: 0.22, sx: 0.42, sy: 0.34, sz: 0.48, dark: false, leg: false },
  { lx: 0, lz: 0.06, ly: 0.24, sx: 0.34, sy: 0.3, sz: 0.3, dark: false, leg: false },
  { lx: 0, lz: 0.34, ly: 0.26, sx: 0.24, sy: 0.24, sz: 0.22, dark: false, leg: false },
  { lx: -0.26, lz: 0.12, ly: 0.1, sx: 0.1, sy: 0.2, sz: 0.1, dark: true, leg: true, phase: 0 },
  { lx: 0.26, lz: 0.12, ly: 0.1, sx: 0.1, sy: 0.2, sz: 0.1, dark: true, leg: true, phase: Math.PI },
  { lx: -0.24, lz: -0.2, ly: 0.1, sx: 0.1, sy: 0.2, sz: 0.1, dark: true, leg: true, phase: Math.PI },
  { lx: 0.24, lz: -0.2, ly: 0.1, sx: 0.1, sy: 0.2, sz: 0.1, dark: true, leg: true, phase: 0 },
];
const PARTS_PER_BUG = BODY_PARTS.length;

/* ------------------------------------------------------------------ */
/* Pure helpers                                                         */
/* ------------------------------------------------------------------ */

/** Flat, saturated severity ramp: pale yellow (nuisance) -> angry dark red. */
function severityColor(sev, out) {
  const t = Math.max(0, Math.min(1, (sev - 1) / 9));
  const lowR = 0xe8, lowG = 0xc9, lowB = 0x3c;
  const hiR = 0x7a, hiG = 0x0e, hiB = 0x12;
  const r = Math.round(lowR + (hiR - lowR) * t);
  const g = Math.round(lowG + (hiG - lowG) * t);
  const b = Math.round(lowB + (hiB - lowB) * t);
  out.setRGB(r / 255, g / 255, b / 255);
  return out;
}

/**
 * three.js's `InstancedMesh.instanceColor` starts out `null` and is only
 * lazily created the first time `setColorAt` is called — so any code that
 * checks `if (mesh.instanceColor)` *before* ever calling `setColorAt` (as
 * every per-frame color write below does, to skip the work on materials that
 * don't support vertex colors) would deadlock: the guard forever prevents the
 * one call that would satisfy it. Eagerly allocating the attribute up front
 * sidesteps that — same shape three's own lazy path creates internally.
 */
function initInstanceColor(mesh) {
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(mesh.count * 3).fill(1), 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  return mesh;
}

/** Quick scale-up then vanish over [0,1] progress through the death beat. */
function popScale(t) {
  if (t < 0.28) return 1 + (t / 0.28) * 0.55;
  const s = (t - 0.28) / 0.72;
  return Math.max(0, 1.55 * (1 - s * s));
}

/* ------------------------------------------------------------------ */
/* Scratch (module scope, reused every frame — zero per-frame alloc)   */
/* ------------------------------------------------------------------ */

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();
const _color = new THREE.Color();
const _white = new THREE.Color('#ffffff');
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const HIDE_POS = new THREE.Vector3(0, -9999, 0);
const HIDE_SCALE = new THREE.Vector3(0, 0, 0);
const IDENTITY_QUAT = new THREE.Quaternion();

/* ------------------------------------------------------------------ */
/* Component                                                            */
/* ------------------------------------------------------------------ */

/**
 * `hazards`/`buildingsById` are accepted for signature compatibility (and as a
 * cheap defensiveness signal) but unused for rendering: this component is a
 * pure reader of `chase` (the integrator owns building/stepping the shared
 * simulation from those same inputs — see file header).
 * @param {{hazards?: import('../lib/types.js').Hazard[], buildingsById?: Object, chase?: Object|null}} props
 */
export default function Bugs({ hazards = [], buildingsById = {}, chase = null }) { // eslint-disable-line no-unused-vars
  const bugs = chase && Array.isArray(chase.bugs) ? chase.bugs : null;
  const bugCount = bugs ? bugs.length : 0;

  // Per-bug static data derived once per sim identity: base color + a
  // previous-state tracker (to detect the alive -> dying edge for particles).
  const meta = useMemo(() => {
    if (!bugs) return { colors: [], prevState: [] };
    const colors = bugs.map((b) => severityColor(b.severity, new THREE.Color()));
    const prevState = bugs.map((b) => b.state);
    return { colors, prevState };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chase]);

  const bodyMesh = useMemo(() => {
    if (bugCount <= 0) return null;
    const m = new THREE.InstancedMesh(getVoxelGeometry(), getBodyMaterial(), bugCount * PARTS_PER_BUG);
    m.frustumCulled = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    initInstanceColor(m);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chase, bugCount]);

  const particleMesh = useMemo(() => {
    const m = new THREE.InstancedMesh(getVoxelGeometry(), getParticleMaterial(), PARTICLE_SLOTS);
    m.frustumCulled = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    initInstanceColor(m);
    for (let i = 0; i < PARTICLE_SLOTS; i++) {
      _mat4.compose(HIDE_POS, IDENTITY_QUAT, HIDE_SCALE);
      m.setMatrixAt(i, _mat4);
    }
    m.instanceMatrix.needsUpdate = true;
    return m;
  }, []);

  const beaconMesh = useMemo(() => {
    if (bugCount <= 0) return null;
    const m = new THREE.InstancedMesh(getVoxelGeometry(), getBeaconMaterial(), bugCount);
    m.frustumCulled = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    initInstanceColor(m);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chase, bugCount]);

  const particles = useRef(null);
  if (!particles.current) {
    const arr = new Array(PARTICLE_SLOTS);
    for (let i = 0; i < PARTICLE_SLOTS; i++) {
      arr[i] = {
        active: false, t: 0, life: 0.5,
        x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0,
        size: 0.12, color: new THREE.Color('#ffffff'),
      };
    }
    particles.current = arr;
  }
  const nextSlot = useRef(0);
  const markerRef = useRef(null);

  function spawnBurst(bug, color) {
    const arr = particles.current;
    for (let k = 0; k < PARTICLES_PER_BURST; k++) {
      const slot = arr[nextSlot.current % PARTICLE_SLOTS];
      nextSlot.current = (nextSlot.current + 1) % PARTICLE_SLOTS;
      const h = hashStr(bug.id + ':' + k);
      const ang = (h % 6283) / 1000;
      const speed = 0.9 + ((h >>> 8) % 100) / 100 * 1.4;
      slot.active = true;
      slot.t = 0;
      slot.life = 0.35 + ((h >>> 16) % 100) / 100 * 0.25;
      slot.x = bug.x;
      slot.y = 0.25 + bug.severity * 0.03;
      slot.z = bug.z;
      slot.dx = Math.cos(ang) * speed;
      slot.dz = Math.sin(ang) * speed;
      slot.dy = 1.4 + ((h >>> 4) % 100) / 100 * 1.2;
      slot.size = 0.08 + bug.severity * 0.008;
      slot.color.copy(color);
    }
  }

  useFrame((state, delta) => {
    if (!bugs) return;
    const targetedId = playerState.targetedBug;
    const t = state.clock.elapsedTime;

    if (bodyMesh) {
      const colors = meta.colors;
      const prevState = meta.prevState;
      let colorDirty = false;

      for (let i = 0; i < bugs.length; i++) {
        const b = bugs[i];
        const base = colors[i] || _white;

        // Detect a fresh alive -> dying transition to trigger the pop/particles.
        if (prevState[i] !== 'dying' && b.state === 'dying') spawnBurst(b, base);
        prevState[i] = b.state;

        const baseScale = (0.5 + (b.severity - 1) * (1 / 9)) * BUG_SIZE_MULT;
        let sc;
        if (b.state === 'alive') {
          sc = baseScale;
        } else if (b.state === 'dying') {
          const p = Math.max(0, Math.min(1, b.deathT / DEATH_DURATION));
          sc = baseScale * popScale(p);
        } else {
          sc = 0; // dead: hidden
        }

        const isTargeted = targetedId != null && b.id === targetedId && b.state === 'alive';
        // Targeted highlight is never LOD-gated — it must read at any range.
        const flash = isTargeted ? 0.4 + 0.3 * Math.sin(t * 7.5) : 0;

        const cosH = Math.cos(b.heading);
        const sinH = Math.sin(b.heading);

        // Distance LOD: far bugs keep moving (position/heading/color every
        // frame, so nothing pops) but skip the cosmetic burst animation.
        const dpx = b.x - playerState.x;
        const dpz = b.z - playerState.z;
        const nearPlayer = (dpx * dpx + dpz * dpz) < ANIM_CULL_DIST_SQ;
        const scurrying = b.state === 'alive' && !b.pausing && nearPlayer;

        // Bursty "skitter, not glide" character: dashes stretch the body
        // along its heading and squash it across, with a frantic little hop;
        // pauses go dead still. speedT ramps this off the bug's own current
        // velocity, so it self-cancels near zero speed with no extra state.
        const speed = scurrying ? Math.hypot(b.vx, b.vz) : 0;
        const speedT = Math.min(1, speed / BUG_MAX_SPEED);
        const stretch = 1 + 0.3 * speedT;
        const squash = 1 - 0.14 * speedT;
        const hop = scurrying ? Math.abs(Math.sin(t * 14 + b.burstT * 3)) * 0.05 * speedT : 0;

        for (let p = 0; p < PARTS_PER_BUG; p++) {
          const part = BODY_PARTS[p];
          const idx = i * PARTS_PER_BUG + p;
          const legBob = part.leg && scurrying ? Math.sin(t * 14 + part.phase) * 0.05 : 0;
          const lx = part.lx * squash;
          const lz = part.lz * stretch;
          const wx = b.x + (lx * cosH - lz * sinH) * sc;
          const wz = b.z + (lx * sinH + lz * cosH) * sc;
          const bottomY = (part.ly - part.sy / 2 + legBob + hop) * sc;
          _pos.set(wx, bottomY, wz);
          _quat.setFromAxisAngle(Y_AXIS, b.heading);
          _scale.set(part.sx * squash * sc, part.sy * sc, part.sz * stretch * sc);
          _mat4.compose(_pos, _quat, _scale);
          bodyMesh.setMatrixAt(idx, _mat4);

          if (bodyMesh.instanceColor) {
            _color.copy(base);
            if (part.dark) _color.multiplyScalar(0.55);
            if (flash > 0) _color.lerp(_white, flash);
            bodyMesh.setColorAt(idx, _color);
            colorDirty = true;
          }
        }

        // --- red wayfinding beacon: one instanced column per bug ---
        if (beaconMesh) {
          let heightMul = 0;
          let widthMul = 1;
          let colorMul = 1;
          if (b.state === 'alive') {
            heightMul = 1;
            if (isTargeted) {
              widthMul = BEACON_TARGET_WIDTH_MULT;
              colorMul = 1.3 + 0.5 * Math.sin(t * 6.5); // pulsing, same cadence as the body flash
            }
          } else if (b.state === 'dying') {
            // Brief flare that fades to nothing over the same death window as
            // the body pop, rather than an instant cut.
            const p2 = Math.max(0, Math.min(1, b.deathT / DEATH_DURATION));
            const flare = 1 - p2;
            heightMul = flare;
            widthMul = 1 + flare * 1.6;
            colorMul = 1 + flare * 1.8;
          } // dead: heightMul stays 0 — column gone.

          // Fade/thin right on top of the player so it never reads as a
          // full-screen wall of additive red when standing next to a bug.
          const distToCam = Math.sqrt(dpx * dpx + dpz * dpz);
          const closeFade = Math.min(1, distToCam / BEACON_CLOSE_FADE_DIST);
          widthMul *= 0.4 + 0.6 * closeFade;

          const bw = BEACON_WIDTH * widthMul;
          _pos.set(b.x, 0, b.z);
          _scale.set(bw, BEACON_HEIGHT * heightMul, bw);
          _mat4.compose(_pos, IDENTITY_QUAT, _scale);
          beaconMesh.setMatrixAt(i, _mat4);
          if (beaconMesh.instanceColor) {
            _color.copy(isTargeted ? BEACON_TARGET_COLOR : BEACON_BASE_COLOR).multiplyScalar(colorMul);
            beaconMesh.setColorAt(i, _color);
          }
        }
      }
      bodyMesh.instanceMatrix.needsUpdate = true;
      if (colorDirty && bodyMesh.instanceColor) bodyMesh.instanceColor.needsUpdate = true;
      if (beaconMesh) {
        beaconMesh.instanceMatrix.needsUpdate = true;
        if (beaconMesh.instanceColor) beaconMesh.instanceColor.needsUpdate = true;
      }
    }

    // --- death particles: cheap ballistic pop, deterministic per burst ---
    const arr = particles.current;
    let pMatrixDirty = false;
    let pColorDirty = false;
    for (let i = 0; i < PARTICLE_SLOTS; i++) {
      const s = arr[i];
      if (!s.active) continue; // already parked off-screen, no write needed
      pMatrixDirty = true;
      s.t += delta;
      if (s.t >= s.life) {
        s.active = false;
        _mat4.compose(HIDE_POS, IDENTITY_QUAT, HIDE_SCALE);
        particleMesh.setMatrixAt(i, _mat4);
        continue;
      }
      const frac = s.t / s.life;
      const px = s.x + s.dx * s.t;
      const pz = s.z + s.dz * s.t;
      const py = Math.max(0.02, s.y + s.dy * s.t - PARTICLE_GRAVITY * s.t * s.t);
      const sc = s.size * (1 - frac);
      _pos.set(px, py, pz);
      _scale.set(sc, sc, sc);
      _mat4.compose(_pos, IDENTITY_QUAT, _scale);
      particleMesh.setMatrixAt(i, _mat4);
      if (particleMesh.instanceColor) {
        particleMesh.setColorAt(i, s.color);
        pColorDirty = true;
      }
    }
    if (pMatrixDirty) particleMesh.instanceMatrix.needsUpdate = true;
    if (pColorDirty && particleMesh.instanceColor) particleMesh.instanceColor.needsUpdate = true;

    // --- targeted marker: a bobbing/spinning cube right over the hunted bug's
    // head, for the unmissable close-up confirmation (the red beacon column,
    // written per-bug above, already handles "which one across the city" —
    // never LOD-gated, see the flash comment above). ---
    if (markerRef.current) {
      const bug = targetedId != null && chase.bugById ? chase.bugById.get(targetedId) : null;
      if (bug && bug.state === 'alive') {
        const bob = Math.sin(t * 5) * 0.08;
        const pulse = 1 + 0.2 * Math.sin(t * 6.5);
        markerRef.current.position.set(bug.x, 1.3 + bob, bug.z);
        markerRef.current.scale.setScalar(pulse);
        markerRef.current.rotation.y = t * 2.4;
        markerRef.current.visible = true;
      } else {
        markerRef.current.visible = false;
      }
    }
  });

  if (!bugs || bugCount <= 0) return null;

  return (
    <group>
      {bodyMesh && <primitive object={bodyMesh} />}
      <primitive object={particleMesh} />
      {beaconMesh && <primitive object={beaconMesh} />}
      <mesh ref={markerRef} visible={false}>
        <boxGeometry args={[0.35, 0.35, 0.35]} />
        <meshBasicMaterial color="#ffe14d" />
      </mesh>
    </group>
  );
}
