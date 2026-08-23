/**
 * Greptile — a small PACK of street-level voxel critters that roam the city
 * independently and hunt whichever bug the player deploys them onto.
 *
 * SCALE: each creature is ~5.6 world units tall — about 3x human height
 * (EYE_HEIGHT/human NPCs are ~1.8) — a creature you meet at street level, not
 * a skyline monster. All proportions below are the original kaiju rig's
 * numbers times `SCALE` (0.19), so the relative anatomy is unchanged, just
 * shrunk; stride frequency, bob amplitude, and footfall FX are re-tuned
 * separately (see notes at each constant) since those don't scale linearly.
 *
 * VOXEL ART DIRECTION (scratchpad/VOXEL.md): a procedural rig of boxes (no
 * curves/tapers — a "tapered" tail or thigh is just a chain of shrinking
 * boxes) all sharing the world's ONE unit block geometry, `getVoxelGeometry()`
 * from Ground.jsx (baked per-face vertex shading, no PBR). Bright, friendly
 * green so a ~5.6-tall creature still stands out against the city; a small
 * pulsing indicator above its head makes it obvious at a glance which pack
 * members are actively hunting vs. just roaming.
 *
 * BEACON: since these are only ~5.6 tall now, each one also gets a tall thin
 * green box "light column" (Minecraft-beacon style) rising ~90 units above
 * its head — visible from anywhere in the city, over any rooftop. All pack
 * beacons live in ONE shared InstancedMesh (see `beaconMesh`), positioned to
 * follow their creature every frame. The dispatched/hunting one's beacon is
 * distinctly brighter, thicker, and pulses so the player can track exactly
 * which creature is "on the job" — separate from (and green, vs.) the red
 * per-bug beacons Bugs.jsx owns.
 *
 * PACK: `chase.greptiles` is the array of creatures. Each is rendered by its
 * own `<GreptileUnit>` (its own nested Object3D hierarchy + refs + one
 * `useFrame`, mutating rotation/position .set calls only — zero allocation).
 * A single shared set of instanced pools (footfall dust, ground decals, and
 * the beacon column) is owned by the outer component and fed by every unit
 * (dust/decals via `onFootfall`; the beacon reads `chase.greptiles` directly),
 * so those pools don't multiply with pack size.
 *
 * Draw calls: ~24 per creature (torso, belly, 2 arms, 2x(thigh+shin+foot),
 * 4 tail segments, head, snout, 4 eye boxes, jaw, 1 static instanced spine
 * ridge, 1 callout Text/Billboard, 1 hunting-indicator) x 4-creature pack
 * ≈ 96, plus 3 shared instanced pools (dust, decals, beacons) ≈ 99 total.
 * Every mesh references a module-level shared geometry + one of a handful of
 * shared materials — nothing is created per frame.
 *
 * SIMULATION: pure reader of `chase`. The integrator (Scene.jsx) owns
 * stepping the sim and draining kill events — this component never mutates
 * `chase`, it only animates off `chase.greptiles[i]` (and looks up each
 * creature's current target bug via `chase.bugById` to aim its head).
 * Renders nothing if `chase`/`chase.greptiles` is missing or empty.
 */
import * as THREE from 'three';
import { useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Billboard, Text } from '@react-three/drei';
import { getVoxelGeometry, hashStr } from './Ground.jsx';

/* ------------------------------------------------------------------ */
/* Proportions (world units) — street-scale creature, ~5.6 tall overall  */
/* ------------------------------------------------------------------ */

const SCALE = 0.19; // shrinks the original ~29.5u rig down to ~5.6u (~3x human height)

const THIGH_LEN = 7.5 * SCALE;
const SHIN_LEN = 6 * SCALE;
const FOOT_H = 1.6 * SCALE;
const HIP_Y = THIGH_LEN + SHIN_LEN + FOOT_H;
const HIP_SPREAD = 3.4 * SCALE;
const LEG_W = 2.6 * SCALE;
const SHIN_W = 2.1 * SCALE;
const FOOT_W = 2.6 * SCALE;
const FOOT_D = 4 * SCALE;

const TORSO_W = 8 * SCALE, TORSO_H = 12 * SCALE, TORSO_D = 10 * SCALE;
const TORSO_Y = HIP_Y + TORSO_H / 2 - 1.5 * SCALE;

const NECK_LEN = 2 * SCALE;
const HEAD_W = 5 * SCALE, HEAD_H = 5.2 * SCALE, HEAD_D = 5.6 * SCALE;
const NECK_Y = TORSO_Y + TORSO_H / 2 + NECK_LEN / 2; // pivot for head group

const JAW_H = 1.4 * SCALE;
const EYE_SIZE = 1.2 * SCALE, EYE_DEPTH = 0.4 * SCALE;
const PUPIL_SIZE = 0.55 * SCALE, PUPIL_DEPTH = 0.3 * SCALE;

const ARM_Y = TORSO_Y + TORSO_H / 2 - 2.5 * SCALE;
const ARM_SPREAD = TORSO_W / 2 + 0.7 * SCALE;
const ARM_W = 1.6 * SCALE, ARM_LEN = 3.4 * SCALE;

const TAIL_SEGS = 4;
const TAIL_BASE_Y = TORSO_Y - 1.5 * SCALE;
const TAIL_W0 = 2.6 * SCALE, TAIL_LEN0 = 3.2 * SCALE;
const TAIL_SHRINK = 0.5 * SCALE;

// --- animation tuning: these do NOT scale linearly with body size, they're
// re-picked so a small, quick creature reads well up close (brisk cadence,
// short steps, subtle bob) rather than looking like a slow-mo tiny kaiju. ---
const STRIDE_FREQ = 1.0;   // rad of stride phase per unit distance covered (longer legs -> fewer, longer strides)
const HUNT_SWING = 0.75;   // leg swing amplitude while actively hunting/lunging
const ROAM_SWING = 0.42;   // gentler amplitude while idle-roaming
const KNEE_AMPL = 1.0;
const BOB_AMPL = 0.12; // world units: a visible but subtle bounce at this scale
const MAX_HEAD_YAW = 1.15; // clamp so the neck can't spin past its shoulders

const DUST_SLOTS = 36; // up to ~6 concurrent footfalls x 6 cubes, shared by the whole pack
const DUST_PER_BURST = 6;
const DECAL_SLOTS = 10;
const DECAL_LIFE = 0.6;

// --- beacon: a tall thin green light column per creature so a ~5.6-tall pack
// is still spottable city-wide over rooftops. Green (vs. Bugs.jsx's red bug
// beacons); the hunting one is visibly brighter/thicker/pulsing. ---
const BEACON_HEIGHT = 90;   // clears any building height in this world
const BEACON_BASE_Y = NECK_Y + HEAD_H + 0.15; // starts just above the head
const BEAM_W_IDLE = 0.4;
const BEAM_W_HUNT = 0.8;
const BEAM_PULSE_FREQ = 4.5;

/* ------------------------------------------------------------------ */
/* Shared singletons                                                    */
/* ------------------------------------------------------------------ */

let _skinMat = null, _bellyMat = null, _spineMat = null;
let _eyeWhiteMat = null, _eyeDarkMat = null, _mouthMat = null;
let _dustMat = null, _decalMat = null, _alertMat = null, _beaconMat = null;

function getSkinMat() {
  if (!_skinMat) _skinMat = new THREE.MeshLambertMaterial({ color: '#3fbf4a', vertexColors: true });
  return _skinMat;
}
function getBellyMat() {
  if (!_bellyMat) _bellyMat = new THREE.MeshLambertMaterial({ color: '#d9f0a8', vertexColors: true });
  return _bellyMat;
}
function getSpineMat() {
  if (!_spineMat) _spineMat = new THREE.MeshLambertMaterial({ color: '#2b6a30', vertexColors: true });
  return _spineMat;
}
function getEyeWhiteMat() {
  if (!_eyeWhiteMat) _eyeWhiteMat = new THREE.MeshLambertMaterial({ color: '#f7f7ea', vertexColors: true });
  return _eyeWhiteMat;
}
function getEyeDarkMat() {
  if (!_eyeDarkMat) _eyeDarkMat = new THREE.MeshLambertMaterial({ color: '#20241c', vertexColors: true });
  return _eyeDarkMat;
}
function getMouthMat() {
  if (!_mouthMat) _mouthMat = new THREE.MeshLambertMaterial({ color: '#a6394a', vertexColors: true });
  return _mouthMat;
}
function getDustMat() {
  if (!_dustMat) _dustMat = new THREE.MeshLambertMaterial({ color: '#b9a074', vertexColors: true });
  return _dustMat;
}
function getDecalMat() {
  if (!_decalMat) _decalMat = new THREE.MeshLambertMaterial({ color: '#3f5a30', vertexColors: true });
  return _decalMat;
}
function getAlertMat() {
  if (!_alertMat) _alertMat = new THREE.MeshLambertMaterial({ color: '#fff066', vertexColors: true });
  return _alertMat;
}
/** Unlit, additive, transparent — a light column reads as glow, not geometry
 *  (same technique Hazards.jsx already uses for its risk-beacon columns). */
function getBeaconMat() {
  if (!_beaconMat) {
    _beaconMat = new THREE.MeshBasicMaterial({
      color: '#ffffff', // tinted per-instance via instanceColor
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }
  return _beaconMat;
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                         */
/* ------------------------------------------------------------------ */

function normAngle(a) {
  a = ((a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function lerpAngle(a, b, k) {
  return a + normAngle(b - a) * k;
}

/* ------------------------------------------------------------------ */
/* Scratch (module scope — zero per-frame allocation)                   */
/* ------------------------------------------------------------------ */

const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();
const IDENTITY_QUAT = new THREE.Quaternion();
const HIDE_POS = new THREE.Vector3(0, -9999, 0);
const HIDE_SCALE = new THREE.Vector3(0, 0, 0);
const _beamColor = new THREE.Color();
const BEAM_COLOR_IDLE = new THREE.Color('#33cc55');
const BEAM_COLOR_HUNT = new THREE.Color('#c8ffce');

/** A single reusable box, positioned by CENTER (converted to the shared voxel
 *  geometry's bottom-pivot convention) and sized via props — shares geometry+material. */
function Box({ mat, position, size }) {
  const [px, py, pz] = position;
  const [, sy] = size;
  return (
    <mesh geometry={getVoxelGeometry()} material={mat} position={[px, py - sy / 2, pz]} scale={size} />
  );
}

/* ------------------------------------------------------------------ */
/* One creature's rig + animation                                       */
/* ------------------------------------------------------------------ */

/**
 * @param {{chase: Object, index: number, onFootfall: (x:number, z:number) => void}} props
 */
function GreptileUnit({ chase, index, onFootfall }) {
  const rootRef = useRef(null);
  const hipLRef = useRef(null);
  const hipRRef = useRef(null);
  const kneeLRef = useRef(null);
  const kneeRRef = useRef(null);
  const neckRef = useRef(null);
  const jawRef = useRef(null);
  const armLRef = useRef(null);
  const armRRef = useRef(null);
  const tailRefs = useRef([]);
  const calloutRef = useRef(null);
  const alertRef = useRef(null);

  const strideRef = useRef(0);
  const lastHalfCycleRef = useRef(0);
  const headYawRef = useRef(0);
  const prevAngleRef = useRef(0);
  const prevCalloutTRef = useRef(0);
  const [calloutText, setCalloutText] = useState('');

  // spine ridge: repeated identical elements -> one small static InstancedMesh
  const spineMesh = useMemo(() => {
    const positions = [
      { z: 3.6 * SCALE, y: TORSO_Y + TORSO_H / 2 + 0.2 * SCALE, s: 1.1 * SCALE },
      { z: 1.8 * SCALE, y: TORSO_Y + TORSO_H / 2 + 0.6 * SCALE, s: 1.4 * SCALE },
      { z: 0, y: TORSO_Y + TORSO_H / 2 + 0.9 * SCALE, s: 1.6 * SCALE },
      { z: -1.8 * SCALE, y: TORSO_Y + TORSO_H / 2 + 0.7 * SCALE, s: 1.4 * SCALE },
      { z: -3.6 * SCALE, y: TORSO_Y + TORSO_H / 2 + 0.4 * SCALE, s: 1.1 * SCALE },
      { z: -5.4 * SCALE, y: TAIL_BASE_Y + 1.2 * SCALE, s: 0.9 * SCALE },
    ];
    const m = new THREE.InstancedMesh(getVoxelGeometry(), getSpineMat(), positions.length);
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      const h = p.s * 1.3;
      _pos.set(0, p.y - h / 2, p.z);
      _scale.set(p.s, h, p.s);
      _mat4.compose(_pos, IDENTITY_QUAT, _scale);
      m.setMatrixAt(i, _mat4);
    }
    m.instanceMatrix.needsUpdate = true;
    m.frustumCulled = false;
    return m;
  }, []);

  useFrame((state, delta) => {
    const g = chase.greptiles[index];
    if (!g || !rootRef.current) return;
    const t = state.clock.elapsedTime;

    const target = g.targetId != null && chase.bugById ? chase.bugById.get(g.targetId) : null;
    const hunting = g.mode === 'hunt' || g.mode === 'lunge';
    const speed = Math.hypot(g.vx, g.vz);

    // --- root transform: position, facing, lean into the turn ---
    const angVel = normAngle(g.angle - prevAngleRef.current) / Math.max(delta, 1e-4);
    prevAngleRef.current = g.angle;
    const lean = Math.max(-0.22, Math.min(0.22, -angVel * 0.05));

    strideRef.current += speed * STRIDE_FREQ * delta;
    const phase = strideRef.current;
    const bob = speed > 0.05 ? Math.abs(Math.sin(phase)) * BOB_AMPL : Math.sin(t * 1.6) * BOB_AMPL * 0.15;
    const lunge = g.mode === 'lunge';

    rootRef.current.position.set(g.x, bob, g.z);
    rootRef.current.rotation.set(lunge ? 0.18 : 0, g.angle, lean);

    // --- legs: hip swing + knee bend, amplitude bigger while hunting ---
    const swingAmpl = speed > 0.05 ? (hunting ? HUNT_SWING : ROAM_SWING) : 0;
    const hipL = Math.sin(phase) * swingAmpl;
    const hipR = Math.sin(phase + Math.PI) * swingAmpl;
    if (hipLRef.current) hipLRef.current.rotation.x = hipL;
    if (hipRRef.current) hipRRef.current.rotation.x = hipR;
    if (kneeLRef.current) kneeLRef.current.rotation.x = Math.max(0, Math.sin(phase)) * KNEE_AMPL;
    if (kneeRRef.current) kneeRRef.current.rotation.x = Math.max(0, Math.sin(phase + Math.PI)) * KNEE_AMPL;

    // footfall detection: one event per half stride cycle while actually moving
    const halfCycle = Math.floor(phase / Math.PI);
    if (halfCycle !== lastHalfCycleRef.current) {
      lastHalfCycleRef.current = halfCycle;
      if (speed > 0.3) {
        const side = halfCycle % 2 === 0 ? 1 : -1;
        const fx = g.x + Math.cos(g.angle + Math.PI / 2) * HIP_SPREAD * side * 0.6 - Math.sin(g.angle) * (1.5 * SCALE);
        const fz = g.z + Math.sin(g.angle + Math.PI / 2) * HIP_SPREAD * side * 0.6 + Math.cos(g.angle) * (1.5 * SCALE);
        onFootfall(fx, fz);
      }
    }

    // --- tiny arms: idle jiggle, a little more excited while hunting ---
    const armAmpl = hunting ? 0.35 : 0.15;
    if (armLRef.current) armLRef.current.rotation.x = -0.3 + Math.sin(phase * 2) * armAmpl;
    if (armRRef.current) armRRef.current.rotation.x = -0.3 + Math.sin(phase * 2 + Math.PI) * armAmpl;

    // --- tail: lagged sway chain, following the stride ---
    const tails = tailRefs.current;
    for (let i = 0; i < tails.length; i++) {
      if (!tails[i]) continue;
      const lag = i * 0.7;
      const ampl = 0.28 * (1 - i * 0.12);
      tails[i].rotation.y = Math.sin(phase * 0.5 - lag) * ampl;
    }

    // --- head: track the current target (or face forward), clamped to the shoulders ---
    let desiredRel = 0;
    if (target) {
      const worldYaw = Math.atan2(target.x - g.x, target.z - g.z);
      desiredRel = Math.max(-MAX_HEAD_YAW, Math.min(MAX_HEAD_YAW, normAngle(worldYaw - g.angle)));
    }
    headYawRef.current = lerpAngle(headYawRef.current, desiredRel, 1 - Math.exp(-delta * 5));
    if (neckRef.current) neckRef.current.rotation.y = headYawRef.current;

    // --- jaw: opens through the chomp bite, closed otherwise ---
    const chompDur = (chase.opts && chase.opts.chompDuration) || 0.35;
    let jawOpen = 0;
    if (g.mode === 'chomp') {
      jawOpen = Math.sin(Math.PI * Math.min(1, g.modeT / chompDur));
    }
    if (jawRef.current) jawRef.current.rotation.x = -jawOpen * 0.55;

    // --- hunting indicator: obvious at a glance which creatures are active ---
    if (alertRef.current) {
      if (hunting || g.mode === 'chomp') {
        alertRef.current.visible = true;
        const pulse = 1 + 0.25 * Math.sin(t * 8);
        alertRef.current.position.y = NECK_Y + HEAD_H + 0.18 + Math.sin(t * 3) * 0.03;
        alertRef.current.scale.setScalar(pulse);
      } else {
        alertRef.current.visible = false;
      }
    }

    // --- "gotcha" callout: rising edge on calloutT starting a fresh catch ---
    if (g.calloutT > prevCalloutTRef.current + 0.001) {
      const lc = g.lastCatch;
      const label = lc.prNumber != null
        ? `PR #${lc.prNumber} — fixed`
        : lc.number != null
          ? `#${lc.number} — fixed`
          : `${lc.kind === 'risk' ? 'risk' : 'bug'} fixed`;
      setCalloutText(label);
    }
    prevCalloutTRef.current = g.calloutT;
    if (calloutRef.current) {
      const total = (chase.opts && chase.opts.calloutDuration) || 2.5;
      const show = g.calloutT > 0;
      calloutRef.current.visible = show;
      if (show) {
        const p = 1 - g.calloutT / total;
        // callout is a root-level sibling of the neck (doesn't rotate with head
        // aim), so its height is measured from the root, not neck-local.
        calloutRef.current.position.set(0, NECK_Y + HEAD_H + 0.4 + p * 0.8, 0);
        const fade = p < 0.8 ? 1 : Math.max(0, 1 - (p - 0.8) / 0.2);
        calloutRef.current.scale.setScalar(fade);
      }
    }
  });

  return (
    <group ref={rootRef}>
      {/* torso + belly */}
      <Box mat={getSkinMat()} position={[0, TORSO_Y, 0]} size={[TORSO_W, TORSO_H, TORSO_D]} />
      <Box mat={getBellyMat()} position={[0, TORSO_Y - TORSO_H * 0.22, TORSO_D * 0.08]} size={[TORSO_W * 0.72, TORSO_H * 0.5, TORSO_D * 0.8]} />
      <primitive object={spineMesh} />

      {/* tiny heroic arms */}
      <group ref={armLRef} position={[-ARM_SPREAD, ARM_Y, TORSO_D * 0.2]}>
        <Box mat={getSkinMat()} position={[0, -ARM_LEN / 2, 0]} size={[ARM_W, ARM_LEN, ARM_W]} />
      </group>
      <group ref={armRRef} position={[ARM_SPREAD, ARM_Y, TORSO_D * 0.2]}>
        <Box mat={getSkinMat()} position={[0, -ARM_LEN / 2, 0]} size={[ARM_W, ARM_LEN, ARM_W]} />
      </group>

      {/* legs: hip -> thigh, knee -> shin + foot */}
      <group ref={hipLRef} position={[-HIP_SPREAD, HIP_Y, 0]}>
        <Box mat={getSkinMat()} position={[0, -THIGH_LEN / 2, 0]} size={[LEG_W, THIGH_LEN, LEG_W]} />
        <group ref={kneeLRef} position={[0, -THIGH_LEN, 0]}>
          <Box mat={getSkinMat()} position={[0, -SHIN_LEN / 2, 0]} size={[SHIN_W, SHIN_LEN, SHIN_W]} />
          <Box mat={getBellyMat()} position={[0, -SHIN_LEN - FOOT_H / 2, 0.9 * SCALE]} size={[FOOT_W, FOOT_H, FOOT_D]} />
        </group>
      </group>
      <group ref={hipRRef} position={[HIP_SPREAD, HIP_Y, 0]}>
        <Box mat={getSkinMat()} position={[0, -THIGH_LEN / 2, 0]} size={[LEG_W, THIGH_LEN, LEG_W]} />
        <group ref={kneeRRef} position={[0, -THIGH_LEN, 0]}>
          <Box mat={getSkinMat()} position={[0, -SHIN_LEN / 2, 0]} size={[SHIN_W, SHIN_LEN, SHIN_W]} />
          <Box mat={getBellyMat()} position={[0, -SHIN_LEN - FOOT_H / 2, 0.9 * SCALE]} size={[FOOT_W, FOOT_H, FOOT_D]} />
        </group>
      </group>

      {/* tail: a chain of shrinking boxes standing in for a taper */}
      <group position={[0, TAIL_BASE_Y, -TORSO_D / 2]}>
        {Array.from({ length: TAIL_SEGS }).map((_, i) => {
          const len = TAIL_LEN0 - i * TAIL_SHRINK;
          const w = TAIL_W0 - i * TAIL_SHRINK;
          return (
            <group key={i} ref={(el) => { tailRefs.current[i] = el; }} position={[0, -i * 0.4 * SCALE, -i * (2.6 * SCALE - i * 0.3 * SCALE)]}>
              <Box mat={getSkinMat()} position={[0, 0, -len / 2]} size={[w, w * 0.9, len]} />
            </group>
          );
        })}
      </group>

      {/* neck -> head -> jaw + eyes */}
      <group ref={neckRef} position={[0, NECK_Y, TORSO_D * 0.3]}>
        <Box mat={getSkinMat()} position={[0, HEAD_H * 0.05, HEAD_D * 0.35]} size={[HEAD_W, HEAD_H, HEAD_D]} />
        {/* blocky friendly snout */}
        <Box mat={getBellyMat()} position={[0, -HEAD_H * 0.12, HEAD_D * 0.75]} size={[HEAD_W * 0.55, HEAD_H * 0.4, HEAD_D * 0.4]} />
        {/* big round friendly eyes */}
        <Box mat={getEyeWhiteMat()} position={[-HEAD_W * 0.28, HEAD_H * 0.18, HEAD_D * 0.62]} size={[EYE_SIZE, EYE_SIZE, EYE_DEPTH]} />
        <Box mat={getEyeWhiteMat()} position={[HEAD_W * 0.28, HEAD_H * 0.18, HEAD_D * 0.62]} size={[EYE_SIZE, EYE_SIZE, EYE_DEPTH]} />
        <Box mat={getEyeDarkMat()} position={[-HEAD_W * 0.28, HEAD_H * 0.18, HEAD_D * 0.82]} size={[PUPIL_SIZE, PUPIL_SIZE, PUPIL_DEPTH]} />
        <Box mat={getEyeDarkMat()} position={[HEAD_W * 0.28, HEAD_H * 0.18, HEAD_D * 0.82]} size={[PUPIL_SIZE, PUPIL_SIZE, PUPIL_DEPTH]} />
        {/* jaw hinge for the chomp beat */}
        <group ref={jawRef} position={[0, -HEAD_H * 0.32, HEAD_D * 0.35]}>
          <Box mat={getMouthMat()} position={[0, -JAW_H / 2, HEAD_D * 0.15]} size={[HEAD_W * 0.75, JAW_H, HEAD_D * 0.55]} />
        </group>
      </group>

      {/* hunting indicator: small pulsing marker, visible only while active */}
      <mesh ref={alertRef} visible={false} geometry={getVoxelGeometry()} material={getAlertMat()} scale={[0.16, 0.16, 0.16]} />

      {/* "PR #123 — fixed" gotcha callout */}
      <group ref={calloutRef} visible={false} position={[0, NECK_Y + HEAD_H + 0.4, 0]}>
        <Billboard>
          <Text fontSize={0.55} color="#eafce0" outlineWidth={0.035} outlineColor="#1c3d1a" anchorX="center" anchorY="middle">
            {calloutText}
          </Text>
        </Billboard>
      </group>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Component: the whole pack + shared footfall FX pools                 */
/* ------------------------------------------------------------------ */

/**
 * `buildingsById` is accepted for signature compatibility; unused for
 * rendering (each creature is positioned/animated entirely from
 * `chase.greptiles[i]` and `chase.bugById`).
 * @param {{chase?: Object|null, buildingsById?: Object}} props
 */
export default function Greptile({ chase = null, buildingsById = {} }) { // eslint-disable-line no-unused-vars
  const hasSim = !!(chase && Array.isArray(chase.greptiles) && chase.greptiles.length > 0);

  // --- shared footfall dust pool (small — this is a street-scale creature) ---
  const dust = useRef(null);
  if (!dust.current) {
    const arr = new Array(DUST_SLOTS);
    for (let i = 0; i < DUST_SLOTS; i++) {
      arr[i] = { active: false, t: 0, life: 0.4, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0, size: 0.075 };
    }
    dust.current = arr;
  }
  const nextDustSlot = useRef(0);
  const dustMesh = useMemo(() => {
    const m = new THREE.InstancedMesh(getVoxelGeometry(), getDustMat(), DUST_SLOTS);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < DUST_SLOTS; i++) {
      _mat4.compose(HIDE_POS, IDENTITY_QUAT, HIDE_SCALE);
      m.setMatrixAt(i, _mat4);
    }
    m.instanceMatrix.needsUpdate = true;
    m.frustumCulled = false;
    return m;
  }, []);

  // --- shared ground decal pool (flattened boxes that shrink out, no alpha needed) ---
  const decals = useRef(null);
  if (!decals.current) {
    const arr = new Array(DECAL_SLOTS);
    for (let i = 0; i < DECAL_SLOTS; i++) arr[i] = { active: false, t: 0, x: 0, z: 0, size: 0.42 };
    decals.current = arr;
  }
  const nextDecalSlot = useRef(0);
  const decalMesh = useMemo(() => {
    const m = new THREE.InstancedMesh(getVoxelGeometry(), getDecalMat(), DECAL_SLOTS);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < DECAL_SLOTS; i++) {
      _mat4.compose(HIDE_POS, IDENTITY_QUAT, HIDE_SCALE);
      m.setMatrixAt(i, _mat4);
    }
    m.instanceMatrix.needsUpdate = true;
    m.frustumCulled = false;
    return m;
  }, []);

  // --- shared beacon pool: one instance per pack member, always sized to
  // the pack (fixed for the sim's lifetime), so this is built once. ---
  const packSize = hasSim ? chase.greptiles.length : 0;
  const beaconMesh = useMemo(() => {
    const count = Math.max(packSize, 1);
    const m = new THREE.InstancedMesh(getVoxelGeometry(), getBeaconMat(), count);
    m.count = packSize; // only draw the actual pack members
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < count; i++) {
      _mat4.compose(HIDE_POS, IDENTITY_QUAT, HIDE_SCALE);
      m.setMatrixAt(i, _mat4);
    }
    m.instanceMatrix.needsUpdate = true;
    m.frustumCulled = false;
    return m;
  }, [packSize]);

  function triggerFootfall(worldX, worldZ) {
    // small deterministic burst of tiny cubes kicked up + outward
    for (let k = 0; k < DUST_PER_BURST; k++) {
      const slot = dust.current[nextDustSlot.current % DUST_SLOTS];
      nextDustSlot.current = (nextDustSlot.current + 1) % DUST_SLOTS;
      const h = hashStr('greptile-dust:' + worldX.toFixed(2) + ':' + worldZ.toFixed(2) + ':' + k);
      const ang = (h % 6283) / 1000;
      const speed = 0.5 + ((h >>> 8) % 100) / 100 * 0.65;
      slot.active = true;
      slot.t = 0;
      slot.life = 0.3 + ((h >>> 16) % 100) / 100 * 0.25;
      slot.x = worldX;
      slot.y = 0.03;
      slot.z = worldZ;
      slot.dx = Math.cos(ang) * speed;
      slot.dz = Math.sin(ang) * speed;
      slot.dy = 0.75 + ((h >>> 4) % 100) / 100 * 0.9;
      slot.size = 0.05 + ((h >>> 20) % 100) / 100 * 0.05;
    }
    // one small ground-print decal right under the foot
    const d = decals.current[nextDecalSlot.current % DECAL_SLOTS];
    nextDecalSlot.current = (nextDecalSlot.current + 1) % DECAL_SLOTS;
    d.active = true;
    d.t = 0;
    d.x = worldX;
    d.z = worldZ;
    d.size = 0.42;
  }

  useFrame((state, delta) => {
    // --- beacon columns: follow every creature; the hunting one is brighter,
    // thicker, and pulses so it's obvious which one is "on the job". ---
    if (packSize > 0) {
      const t = state.clock.elapsedTime;
      const greptiles = chase.greptiles;
      for (let i = 0; i < greptiles.length; i++) {
        const g = greptiles[i];
        const hunting = g.mode !== 'idle';
        const pulse = hunting ? 0.75 + 0.25 * Math.sin(t * BEAM_PULSE_FREQ) : 1;
        const w = (hunting ? BEAM_W_HUNT : BEAM_W_IDLE) * pulse;
        _pos.set(g.x, BEACON_BASE_Y, g.z);
        _scale.set(w, BEACON_HEIGHT, w);
        _mat4.compose(_pos, IDENTITY_QUAT, _scale);
        beaconMesh.setMatrixAt(i, _mat4);
        if (beaconMesh.instanceColor) {
          _beamColor.copy(hunting ? BEAM_COLOR_HUNT : BEAM_COLOR_IDLE);
          beaconMesh.setColorAt(i, _beamColor);
        }
      }
      beaconMesh.instanceMatrix.needsUpdate = true;
      if (beaconMesh.instanceColor) beaconMesh.instanceColor.needsUpdate = true;
    }

    // --- dust particles ---
    let dustDirty = false;
    for (let i = 0; i < DUST_SLOTS; i++) {
      const s = dust.current[i];
      if (!s.active) continue;
      dustDirty = true;
      s.t += delta;
      if (s.t >= s.life) {
        s.active = false;
        _mat4.compose(HIDE_POS, IDENTITY_QUAT, HIDE_SCALE);
        dustMesh.setMatrixAt(i, _mat4);
        continue;
      }
      const frac = s.t / s.life;
      const px = s.x + s.dx * s.t;
      const pz = s.z + s.dz * s.t;
      const py = Math.max(0.01, s.y + s.dy * s.t - 6 * s.t * s.t);
      const sc = s.size * (1 - frac * 0.7);
      _pos.set(px, py - sc / 2, pz);
      _scale.set(sc, sc, sc);
      _mat4.compose(_pos, IDENTITY_QUAT, _scale);
      dustMesh.setMatrixAt(i, _mat4);
    }
    if (dustDirty) dustMesh.instanceMatrix.needsUpdate = true;

    // --- ground decals: flattened boxes that shrink out ---
    let decalDirty = false;
    for (let i = 0; i < DECAL_SLOTS; i++) {
      const d = decals.current[i];
      if (!d.active) continue;
      decalDirty = true;
      d.t += delta;
      if (d.t >= DECAL_LIFE) {
        d.active = false;
        _mat4.compose(HIDE_POS, IDENTITY_QUAT, HIDE_SCALE);
        decalMesh.setMatrixAt(i, _mat4);
        continue;
      }
      const frac = d.t / DECAL_LIFE;
      const sc = d.size * (1 - frac);
      _pos.set(d.x, 0.01, d.z);
      _scale.set(sc, 0.03, sc);
      _mat4.compose(_pos, IDENTITY_QUAT, _scale);
      decalMesh.setMatrixAt(i, _mat4);
    }
    if (decalDirty) decalMesh.instanceMatrix.needsUpdate = true;
  });

  if (!hasSim) return null;

  return (
    <group>
      {chase.greptiles.map((g, i) => (
        <GreptileUnit key={g.id} chase={chase} index={i} onFootfall={triggerFootfall} />
      ))}
      <primitive object={dustMesh} />
      <primitive object={decalMesh} />
      <primitive object={beaconMesh} />
    </group>
  );
}
