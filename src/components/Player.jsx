/**
 * Player — first-person controller driving the R3F camera.
 *
 * Renders no visible mesh; returns <PointerLockControls /> and moves the camera
 * itself inside useFrame. Publishes position/yaw/focus into the shared mutable
 * `playerState` every frame (no React state, no re-renders).
 *
 * Controls:
 *   Click        lock pointer (mouse look) — Esc releases
 *   W/A/S/D      move (arrow keys also work)
 *   Shift        sprint
 *   Space        jump (walk mode) / rise (fly mode)
 *   C or Ctrl    descend (fly mode); no-op crouch in walk mode
 *   F            toggle fly mode
 *
 * Extra OPTIONAL fields written onto playerState at runtime (documented here,
 * not required by the shared contract — readers must treat them as optional):
 *   playerState.flying    {boolean} true while fly mode is active
 *   playerState.sprinting {boolean} true while sprint is held and moving
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { PointerLockControls } from '@react-three/drei';
import * as THREE from 'three';
import { playerState } from '../lib/playerState.js';
import { EYE_HEIGHT } from '../lib/types.js';

const WALK_SPEED = 6;
const SPRINT_SPEED = 12;
const FLY_MULT = 1.4;          // fly moves a bit faster for the city-overview beat
const ACCEL = 11;              // velocity lerp rate (per second) — snappy, not floaty
const GRAVITY = 30;
const JUMP_SPEED = 9;
const PLAYER_RADIUS = 0.6;
const CELL = 8;                // spatial hash cell size (world units)
const FOCUS_RANGE = 14;
const FOCUS_DOT = 0.6;
const MAX_FLY_Y = 140;
const BOUNDS_MARGIN = 50;      // generous apron around the city
const MAX_DT = 0.05;           // clamp delta so hitches can't tunnel through walls

// Numeric spatial-hash key (no string allocation in the frame loop).
const KEY_OFF = 2048;
const KEY_SPAN = 4096;
function cellKey(cx, cz) {
  return (cx + KEY_OFF) * KEY_SPAN + (cz + KEY_OFF);
}

// Scratch objects — created once, reused every frame. Never allocate in useFrame.
const _dir = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);

export default function Player({ buildings = [], spawn = { x: 0, y: 2, z: 0 } }) {
  const camera = useThree((s) => s.camera);
  const controlsRef = useRef(null);

  // ---- input state (mutable, listener-driven, never re-renders) ----
  const keys = useRef({
    fwd: false, back: false, left: false, right: false,
    sprint: false, up: false, down: false,
  });
  const flying = useRef(false);
  const vel = useRef(new THREE.Vector3(0, 0, 0));
  const grounded = useRef(true);

  // ---- spatial hash + world bounds, rebuilt only when `buildings` changes ----
  const world = useMemo(() => {
    const grid = new Map(); // numeric cell key -> Building[]
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const list = Array.isArray(buildings) ? buildings : [];
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.z)) continue;
      const hw = (b.w || 1) / 2;
      const hd = (b.d || 1) / 2;
      minX = Math.min(minX, b.x - hw); maxX = Math.max(maxX, b.x + hw);
      minZ = Math.min(minZ, b.z - hd); maxZ = Math.max(maxZ, b.z + hd);
      // Insert into every cell the (radius-expanded) footprint overlaps.
      const x0 = Math.floor((b.x - hw - PLAYER_RADIUS) / CELL);
      const x1 = Math.floor((b.x + hw + PLAYER_RADIUS) / CELL);
      const z0 = Math.floor((b.z - hd - PLAYER_RADIUS) / CELL);
      const z1 = Math.floor((b.z + hd + PLAYER_RADIUS) / CELL);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const k = cellKey(cx, cz);
          let arr = grid.get(k);
          if (!arr) { arr = []; grid.set(k, arr); }
          arr.push(b);
        }
      }
    }
    if (!Number.isFinite(minX)) { minX = -60; maxX = 60; minZ = -60; maxZ = 60; }
    return {
      grid,
      minX: minX - BOUNDS_MARGIN, maxX: maxX + BOUNDS_MARGIN,
      minZ: minZ - BOUNDS_MARGIN, maxZ: maxZ + BOUNDS_MARGIN,
    };
  }, [buildings]);

  // ---- keyboard listeners (plain window events; drei KeyboardControls not used) ----
  useEffect(() => {
    const k = keys.current;
    const down = (e) => {
      switch (e.code) {
        case 'KeyW': case 'ArrowUp': k.fwd = true; break;
        case 'KeyS': case 'ArrowDown': k.back = true; break;
        case 'KeyA': case 'ArrowLeft': k.left = true; break;
        case 'KeyD': case 'ArrowRight': k.right = true; break;
        case 'ShiftLeft': case 'ShiftRight': k.sprint = true; break;
        case 'Space': k.up = true; break;
        case 'KeyC': case 'ControlLeft': case 'ControlRight': k.down = true; break;
        case 'KeyF':
          if (!e.repeat) {
            flying.current = !flying.current;
            playerState.flying = flying.current;
            if (flying.current) vel.current.y = 0;
          }
          break;
        default: return;
      }
      // Stop the page from scrolling / triggering browser shortcuts.
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    };
    const up = (e) => {
      switch (e.code) {
        case 'KeyW': case 'ArrowUp': k.fwd = false; break;
        case 'KeyS': case 'ArrowDown': k.back = false; break;
        case 'KeyA': case 'ArrowLeft': k.left = false; break;
        case 'KeyD': case 'ArrowRight': k.right = false; break;
        case 'ShiftLeft': case 'ShiftRight': k.sprint = false; break;
        case 'Space': k.up = false; break;
        case 'KeyC': case 'ControlLeft': case 'ControlRight': k.down = false; break;
        default: break;
      }
    };
    const blur = () => {
      // Losing window focus eats keyup events — clear everything so no key sticks.
      k.fwd = k.back = k.left = k.right = k.sprint = k.up = k.down = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  // ---- spawn placement: on mount / when spawn changes, look toward city center ----
  useEffect(() => {
    const sx = (spawn && Number.isFinite(spawn.x)) ? spawn.x : 0;
    const sy = (spawn && Number.isFinite(spawn.y)) ? spawn.y : EYE_HEIGHT;
    const sz = (spawn && Number.isFinite(spawn.z)) ? spawn.z : 0;
    camera.position.set(sx, sy, sz);
    // Look at the world origin (kept level); if spawned at origin, look down -Z.
    if (Math.abs(sx) < 0.01 && Math.abs(sz) < 0.01) camera.lookAt(sx, sy, sz - 1);
    else camera.lookAt(0, sy, 0);
    vel.current.set(0, 0, 0);
    grounded.current = true;
    playerState.x = sx; playerState.y = sy; playerState.z = sz;
  }, [camera, spawn]);

  // ---- per-frame simulation ----
  useFrame((_, delta) => {
    const dt = Math.min(delta || 0, MAX_DT);
    const k = keys.current;
    const v = vel.current;
    const pos = camera.position;
    const fly = flying.current;

    // Yaw-relative movement basis: camera forward flattened onto XZ so that
    // pitch never tilts movement (looking up must not launch the player).
    camera.getWorldDirection(_dir);
    const yaw = Math.atan2(-_dir.x, -_dir.z);
    _fwd.set(_dir.x, 0, _dir.z);
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1); else _fwd.normalize();
    _right.crossVectors(_fwd, _UP); // strafe-right on XZ

    // Only take input while pointer-locked; otherwise glide to a stop.
    const active = playerState.locked;
    let ix = 0, iz = 0;
    if (active) {
      if (k.fwd) iz += 1;
      if (k.back) iz -= 1;
      if (k.right) ix += 1;
      if (k.left) ix -= 1;
    }
    const sprinting = active && k.sprint && (ix !== 0 || iz !== 0);
    let speed = sprinting ? SPRINT_SPEED : WALK_SPEED;
    if (fly) speed *= FLY_MULT;

    // Target horizontal velocity (normalized diagonal), then smooth toward it.
    let tx = _fwd.x * iz + _right.x * ix;
    let tz = _fwd.z * iz + _right.z * ix;
    const tlen = Math.hypot(tx, tz);
    if (tlen > 1e-6) { tx = (tx / tlen) * speed; tz = (tz / tlen) * speed; }
    else { tx = 0; tz = 0; }
    const blend = 1 - Math.exp(-ACCEL * dt); // framerate-independent lerp
    v.x += (tx - v.x) * blend;
    v.z += (tz - v.z) * blend;

    // Vertical.
    if (fly) {
      let ty = 0;
      if (active && k.up) ty += speed;
      if (active && k.down) ty -= speed;
      v.y += (ty - v.y) * blend;
    } else {
      v.y -= GRAVITY * dt;
      if (grounded.current && active && k.up) {
        v.y = JUMP_SPEED;
        grounded.current = false;
      }
    }

    // Integrate + collide, X and Z resolved SEPARATELY so we slide along walls.
    const grid = world.grid;
    const feetY = pos.y - EYE_HEIGHT;

    pos.x += v.x * dt;
    collideAxis(grid, pos, feetY, 0, v);
    pos.z += v.z * dt;
    collideAxis(grid, pos, feetY, 1, v);

    pos.y += v.y * dt;
    if (pos.y <= EYE_HEIGHT) { // flat ground plane
      pos.y = EYE_HEIGHT;
      v.y = 0;
      grounded.current = true;
    } else if (!fly) {
      grounded.current = false;
    }
    if (pos.y > MAX_FLY_Y) { pos.y = MAX_FLY_Y; if (v.y > 0) v.y = 0; }

    // Soft-clamp to a generous box around the city — no walking into the void.
    if (pos.x < world.minX) { pos.x = world.minX; if (v.x < 0) v.x = 0; }
    if (pos.x > world.maxX) { pos.x = world.maxX; if (v.x > 0) v.x = 0; }
    if (pos.z < world.minZ) { pos.z = world.minZ; if (v.z < 0) v.z = 0; }
    if (pos.z > world.maxZ) { pos.z = world.maxZ; if (v.z > 0) v.z = 0; }

    // Publish shared state.
    playerState.x = pos.x;
    playerState.y = pos.y;
    playerState.z = pos.z;
    playerState.yaw = yaw;
    playerState.sprinting = sprinting;

    // Focus detection: nearest building within FOCUS_RANGE, roughly in front.
    // 5x5 cells (radius 2) around the player covers the 14-unit range on 8-unit cells.
    let best = null;
    let bestDist = Infinity;
    const pcx = Math.floor(pos.x / CELL);
    const pcz = Math.floor(pos.z / CELL);
    for (let cx = pcx - 2; cx <= pcx + 2; cx++) {
      for (let cz = pcz - 2; cz <= pcz + 2; cz++) {
        const arr = grid.get(cellKey(cx, cz));
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          const b = arr[i];
          const dx = b.x - pos.x;
          const dz = b.z - pos.z;
          const dist = Math.hypot(dx, dz);
          if (dist >= FOCUS_RANGE || dist >= bestDist || dist < 1e-4) continue;
          const dot = (dx / dist) * _fwd.x + (dz / dist) * _fwd.z;
          if (dot > FOCUS_DOT) { best = b; bestDist = dist; }
        }
      }
    }
    playerState.focusedBuilding = best ? best.id : null;
    playerState.focusedDistance = best ? bestDist : Infinity;
  });

  return (
    <PointerLockControls
      ref={controlsRef}
      makeDefault
      onLock={() => { playerState.locked = true; }}
      onUnlock={() => {
        playerState.locked = false;
        // Drop held keys so nothing sticks while unlocked.
        const k = keys.current;
        k.fwd = k.back = k.left = k.right = k.sprint = k.up = k.down = false;
      }}
    />
  );
}

/**
 * Push the player cylinder (radius PLAYER_RADIUS) out of any overlapping
 * building AABB along one axis. axis: 0 = X, 1 = Z. Buildings whose roof is
 * below the player's feet are ignored (fly-over; also lets jumps clear stubs).
 * Tests only the 9 grid cells around the player.
 */
function collideAxis(grid, pos, feetY, axis, v) {
  const pcx = Math.floor(pos.x / CELL);
  const pcz = Math.floor(pos.z / CELL);
  for (let cx = pcx - 1; cx <= pcx + 1; cx++) {
    for (let cz = pcz - 1; cz <= pcz + 1; cz++) {
      const arr = grid.get(cellKey(cx, cz));
      if (!arr) continue;
      for (let i = 0; i < arr.length; i++) {
        const b = arr[i];
        const h = Number.isFinite(b.height) ? b.height : 10;
        if (feetY >= h - 0.01) continue; // above the roof — no collision
        const hx = (b.w || 1) / 2 + PLAYER_RADIUS;
        const hz = (b.d || 1) / 2 + PLAYER_RADIUS;
        const dx = pos.x - b.x;
        const dz = pos.z - b.z;
        if (dx > -hx && dx < hx && dz > -hz && dz < hz) {
          if (axis === 0) {
            pos.x = b.x + (dx >= 0 ? hx : -hx);
            v.x = 0;
          } else {
            pos.z = b.z + (dz >= 0 ? hz : -hz);
            v.z = 0;
          }
        }
      }
    }
  }
}
