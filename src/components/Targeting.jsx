/**
 * Targeting — aims at bugs and deploys Greptile.
 *
 * Every ~3rd frame: reads the live bug list out of `chase` (owned by another
 * agent's chase simulation — read defensively, shape/liveness unknown), turns
 * it into a candidate list, and calls the pure `pickTarget` with the real R3F
 * camera's world position + view direction. The result is written onto
 * `playerState.targetedBug` / `playerState.targetedBugDistance` every pass
 * (every frame it either confirms the pick or clears it), so other systems
 * (HUD reticle state, chase sim) always see a fresh answer.
 *
 * Input: E (primary) or left-click while pointer-locked (alias) deploys
 * Greptile at the current target — sets `playerState.deployRequested = true`
 * (the chase sim consumes + resets it) and calls `onDeploy(bugId)`. Ignored
 * whenever `playerState.uiFocused` is true or the pointer isn't locked.
 *
 * Renders a small billboarded voxel bracket + downward chevron hovering over
 * the targeted bug (bobbing gently) plus a flat ground-highlight pad under
 * it, and a "press E to deploy Greptile" drei <Text> label. Nothing is drawn
 * when there is no target. This is a single overlay (never more than one
 * live target at a time) so it is a handful of small boxes, not instanced —
 * instancing is for repeated props, not a one-off HUD-ish marker.
 */
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { Billboard, Text } from '@react-three/drei';
import { playerState } from '../lib/playerState.js';
import { pickTarget } from '../lib/targeting.js';

// Aiming is deliberately precise now: you must actually put the crosshair on a bug or on
// its red beacon column, rather than vaguely facing its direction. That's possible with a
// tight cone only because pickTarget measures against the whole beam segment (see
// BEAM_HEIGHT below) — the beam is a tall, easy-to-hit target even from across the city,
// while the narrow cone stops it from grabbing bugs you aren't looking at.
const MAX_DISTANCE = 140;      // world units — reach most of a district from where you stand
const CONE_DEGREES = 5;        // half-angle — must genuinely be on the bug or its beam
// Must match the beacon column height in Bugs.jsx (beams rise to y=46).
const BEAM_HEIGHT = 46;
const THROTTLE_FRAMES = 3;     // re-pick the target every 3rd frame; doesn't need 60Hz
const DEFAULT_RADIUS = 0.5;    // fallback bug radius if the chase sim omits it
const HOVER_GAP = 0.9;         // marker floats this far above the bug's radius
const BOB_AMPLITUDE = 0.12;
const BOB_SPEED = 2.2;         // radians/sec
const MAX_CANDIDATES = 256;    // hard cap so a runaway bug list can't blow up the frame

/* ------------------------------------------------------------------ */
/* Module-scope scratch — zero allocation inside useFrame              */
/* ------------------------------------------------------------------ */
const _dir = new THREE.Vector3();
const _camObj = { x: 0, y: 0, z: 0, dirX: 0, dirY: 0, dirZ: -1 };
// Reused candidate array + a growable-only pool of reused slot objects, so
// re-picking the target every 3rd frame never allocates new objects/arrays
// (beyond the pool's one-time growth the first time more bugs show up).
const _candidates = [];
const _pool = [];
function poolSlot(i) {
  let s = _pool[i];
  if (!s) {
    s = { id: null, x: 0, y: 0, z: 0, radius: DEFAULT_RADIUS, beamHeight: 0, ref: null };
    _pool[i] = s;
  }
  return s;
}

const BOX = new THREE.BoxGeometry(1, 1, 1);
const BRACKET_MATERIAL = new THREE.MeshBasicMaterial({ color: '#ffe94d' });
const CHEVRON_MATERIAL = new THREE.MeshBasicMaterial({ color: '#fff7cf' });
const PAD_MATERIAL = new THREE.MeshBasicMaterial({
  color: '#7dffb0', transparent: true, opacity: 0.32, depthWrite: false,
});

// Bracket: 4 corner "L"s (2 bars each) around a square of half-size H.
const BRACKET_H = 0.5;
const BAR_LEN = 0.34;
const BAR_THICK = 0.06;
const BRACKET_BARS = (() => {
  const corners = [
    [-BRACKET_H, BRACKET_H], [BRACKET_H, BRACKET_H],
    [-BRACKET_H, -BRACKET_H], [BRACKET_H, -BRACKET_H],
  ];
  const bars = [];
  for (const [cx, cy] of corners) {
    const sx = cx >= 0 ? -1 : 1; // bar extends inward, toward center
    const sy = cy >= 0 ? -1 : 1;
    bars.push({ pos: [cx + sx * BAR_LEN / 2, cy, 0], scale: [BAR_LEN, BAR_THICK, BAR_THICK] });
    bars.push({ pos: [cx, cy + sy * BAR_LEN / 2, 0], scale: [BAR_THICK, BAR_LEN, BAR_THICK] });
  }
  return bars;
})();

// Downward chevron ("v") beneath the bracket, pointing at the bug.
const CHEVRON_ARM_LEN = 0.32;
const CHEVRON_THICK = 0.07;
const CHEVRON_Y = -BRACKET_H - 0.22;
const CHEVRON_ARMS = [
  { pos: [-0.13, CHEVRON_Y, 0], rot: [0, 0, Math.PI / 4] },
  { pos: [0.13, CHEVRON_Y, 0], rot: [0, 0, -Math.PI / 4] },
];

/* ------------------------------------------------------------------ */
/* Defensive chase-state reading                                       */
/* ------------------------------------------------------------------ */

/**
 * Pull a live bug array out of `chase`. Shape is owned by another agent and
 * may be null/undefined, a bare array, or an object exposing the list under
 * one of a few likely keys — try each, fall back to null (no bugs).
 */
function extractBugs(chase) {
  if (!chase) return null;
  if (Array.isArray(chase)) return chase;
  if (Array.isArray(chase.bugs)) return chase.bugs;
  if (Array.isArray(chase.entities)) return chase.entities;
  if (Array.isArray(chase.list)) return chase.list;
  if (Array.isArray(chase.active)) return chase.active;
  return null;
}

/** True if a bug entry looks dead/removed under any of the plausible flags. */
function isDeadBug(b) {
  if (!b) return true;
  if (b.dead === true || b.isDead === true || b.alive === false) return true;
  if (typeof b.state === 'string' && /dead|killed|gone|removed|despawn/i.test(b.state)) return true;
  if (typeof b.hp === 'number' && b.hp <= 0) return true;
  if (typeof b.health === 'number' && b.health <= 0) return true;
  return false;
}

export default function Targeting({ chase = null, onDeploy = null }) {
  const camera = useThree((s) => s.camera);
  const frameCount = useRef(0);
  const onDeployRef = useRef(onDeploy);
  onDeployRef.current = onDeploy;

  // Live reference to the currently-targeted bug OBJECT (not a copy), so the
  // marker can track its motion every frame even between re-selection passes
  // (selection itself is throttled; following the target should not be).
  const targetObjRef = useRef(null);

  const groupRef = useRef(null);
  const highlightRef = useRef(null);

  /* ---- input: E key + left-click-while-locked deploy the target ---- */
  useEffect(() => {
    // `requireLock` is the difference between the two input paths: the E key must work even
    // when the pointer isn't locked (otherwise pressing E does nothing at all while the HUD
    // is still showing the DEPLOY prompt, which reads as the game being broken), but a plain
    // left-click must NOT deploy while unlocked — that click is how the player engages
    // pointer lock to look around in the first place.
    const tryDeploy = (requireLock) => {
      if (playerState.uiFocused) return;
      if (requireLock && !playerState.locked) return;
      const bugId = playerState.targetedBug;
      if (bugId == null) return;
      playerState.deployRequested = true;
      // Stamped so the deploy toast can confirm the press landed. Uses performance.now()
      // rather than Date.now() so it's monotonic and unaffected by clock changes.
      playerState.lastDeploy = { bugId, at: performance.now() };
      const fn = onDeployRef.current;
      if (typeof fn === 'function') fn(bugId);
    };
    const onKeyDown = (e) => {
      if (e.code !== 'KeyE' || e.repeat) return;
      tryDeploy(false);
    };
    const onMouseDown = (e) => {
      if (e.button !== 0) return; // left click only
      tryDeploy(true);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onMouseDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onMouseDown);
    };
  }, []);

  useFrame((state) => {
    frameCount.current++;
    const recompute = frameCount.current % THROTTLE_FRAMES === 0;

    if (recompute) {
      const bugs = extractBugs(chase);
      let n = 0;
      if (bugs) {
        const len = Math.min(bugs.length, MAX_CANDIDATES);
        for (let i = 0; i < len; i++) {
          const b = bugs[i];
          if (isDeadBug(b)) continue;
          if (!Number.isFinite(b.x) || !Number.isFinite(b.z)) continue;
          // The chase sim (src/lib/chase.js) is a pure ground-plane (x/z) simulation
          // and never carries a `y` field on its bug entities — Bugs.jsx renders
          // every bug rooted at y=0 too, so that's the correct default here rather
          // than treating a merely-2D bug as an invalid candidate.
          const by = Number.isFinite(b.y) ? b.y : 0;
          const slot = poolSlot(n);
          slot.id = b.id != null ? b.id : i;
          slot.x = b.x; slot.y = by; slot.z = b.z;
          slot.radius = Number.isFinite(b.radius) ? b.radius : DEFAULT_RADIUS;
          // The bug's beacon column is part of its hit target, so aiming at the beam
          // counts as aiming at the bug.
          slot.beamHeight = BEAM_HEIGHT;
          slot.ref = b;
          n++;
        }
      }
      _candidates.length = 0;
      for (let i = 0; i < n; i++) _candidates.push(_pool[i]);

      camera.getWorldDirection(_dir);
      _camObj.x = camera.position.x;
      _camObj.y = camera.position.y;
      _camObj.z = camera.position.z;
      _camObj.dirX = _dir.x; _camObj.dirY = _dir.y; _camObj.dirZ = _dir.z;

      const targetId = pickTarget(_camObj, _candidates, {
        maxDistance: MAX_DISTANCE,
        coneDegrees: CONE_DEGREES,
      });

      let found = null;
      if (targetId != null) {
        for (let i = 0; i < n; i++) {
          if (_pool[i].id === targetId) { found = _pool[i]; break; }
        }
      }
      if (found) {
        const dx = found.x - _camObj.x, dy = found.y - _camObj.y, dz = found.z - _camObj.z;
        playerState.targetedBug = targetId;
        playerState.targetedBugDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        targetObjRef.current = found.ref;
      } else {
        playerState.targetedBug = null;
        playerState.targetedBugDistance = Infinity;
        targetObjRef.current = null;
      }
    }

    /* ---- visual: follow + bob the marker every frame (not throttled) ---- */
    const bug = targetObjRef.current;
    const g = groupRef.current;
    if (g) {
      const alive = bug && !isDeadBug(bug) &&
        Number.isFinite(bug.x) && Number.isFinite(bug.z);
      if (!alive) {
        g.visible = false;
        if (highlightRef.current) highlightRef.current.visible = false;
        if (bug) {
          // Target died / went invalid between recompute passes — drop it now
          // rather than waiting for the next throttled pass.
          playerState.targetedBug = null;
          playerState.targetedBugDistance = Infinity;
          targetObjRef.current = null;
        }
      } else {
        g.visible = true;
        const radius = Number.isFinite(bug.radius) ? bug.radius : DEFAULT_RADIUS;
        // Same ground-plane default as above: chase.js bugs have no `y` field.
        const by = Number.isFinite(bug.y) ? bug.y : 0;
        const t = state.clock.elapsedTime;
        const bob = Math.sin(t * BOB_SPEED) * BOB_AMPLITUDE;
        g.position.set(bug.x, by + radius + HOVER_GAP + bob, bug.z);
        if (highlightRef.current) {
          highlightRef.current.visible = true;
          highlightRef.current.position.set(bug.x, 0.02, bug.z);
          const s = Math.max(0.6, radius * 1.6);
          highlightRef.current.scale.set(s, 0.02, s);
        }
      }
    }
  });

  return (
    <>
      <mesh ref={highlightRef} geometry={BOX} material={PAD_MATERIAL} visible={false} scale={[1, 0.02, 1]} />
      <group ref={groupRef} visible={false}>
        <Billboard>
          {BRACKET_BARS.map((b, i) => (
            <mesh key={`bar-${i}`} geometry={BOX} material={BRACKET_MATERIAL} position={b.pos} scale={b.scale} />
          ))}
          {CHEVRON_ARMS.map((a, i) => (
            <mesh
              key={`chevron-${i}`}
              geometry={BOX}
              material={CHEVRON_MATERIAL}
              position={a.pos}
              rotation={a.rot}
              scale={[CHEVRON_ARM_LEN, CHEVRON_THICK, CHEVRON_THICK]}
            />
          ))}
          <Text
            position={[0, BRACKET_H + 0.32, 0]}
            fontSize={0.26}
            color="#fff7cf"
            outlineWidth={0.02}
            outlineColor="#1a1a1a"
            anchorX="center"
            anchorY="bottom"
          >
            press E to deploy Greptile
          </Text>
        </Billboard>
      </group>
    </>
  );
}
