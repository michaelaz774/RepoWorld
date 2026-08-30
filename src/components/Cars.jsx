/**
 * Cars — drivable voxel cars parked on the city streets.
 *
 * Three cars (see CAR_COUNT) are placed deterministically on real road
 * segments near the player's spawn by `placeCars` in src/lib/vehicles.js.
 * Walk up to one, press G, and you drive it; press G again to get out.
 *
 * VOXEL ART DIRECTION: same rig as the parked cars in StreetProps.jsx (body,
 * cabin, four wheels, all sharing Ground.jsx's `getVoxelGeometry()` so the
 * whole world still draws from one BoxGeometry) — but built in LOCAL space
 * facing -Z, so the group can be yawed to any angle. StreetProps' cars are
 * axis-aligned props that swap which box dimension is long; a car that steers
 * cannot be, so this is a separate rig rather than a reuse of `addCar`.
 *
 * Only three entities exist, so this follows Greptile.jsx's per-entity
 * `<group ref>` pattern rather than NPCs.jsx's instancing: at this count the
 * draw-call saving is irrelevant and the per-part yaw math is not worth it.
 * Each car carries a tall amber beacon column (same alpha-blended, unlit
 * treatment as the bug/NPC beacons — never additive, which washes out against
 * a bright sky) so you can find one from across town. The beacon is a child of
 * the car group, so it follows for free and disappears while you're driving it.
 *
 * CAMERA: while driving, this component owns the camera completely — a chase
 * cam behind and above the car. That works only because <Cars> is mounted
 * AFTER <Player> in Scene.jsx: R3F runs same-priority useFrame callbacks in
 * subscription order, so this one runs last and its camera writes win. Mouse
 * look is inert while driving for the same reason (PointerLockControls writes
 * camera.quaternion on mousemove, between frames; the chase cam overwrites it
 * every frame before the render).
 *
 * Player.jsx stands down via `playerState.driving`, which means this component
 * takes over publishing playerState.x/y/z — the NPC proximity scan, minimap,
 * code panels and building focus all read those.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Billboard, Text } from '@react-three/drei';
import * as THREE from 'three';
import { getVoxelGeometry } from './Ground.jsx';
import { playerState } from '../lib/playerState.js';
import { EYE_HEIGHT } from '../lib/types.js';
import {
  placeCars,
  stepVehicle,
  resolveCarCollision,
  nearestCar,
  exitPosition,
  headingVector,
  CAR_LENGTH,
  CAR_WIDTH,
  CAR_RADIUS,
} from '../lib/vehicles.js';

const CAR_COUNT = 3;
const ENTER_RADIUS = 4.5;            // tighter than the NPC talk radius — you enter A car
const PROXIMITY_INTERVAL = 0.2;      // seconds between "am I near a car" scans

// Chase camera.
const CAM_BACK = 9.5;                // units behind the car
const CAM_HEIGHT = 4.6;
const CAM_LOOK_AHEAD = 5;
const CAM_LOOK_HEIGHT = 1.4;
const CAM_LERP = 6.5;                // per-second smoothing rate
const CAM_MIN_Y = 1.6;               // never let the chase cam sink into the road

// Beacon column — amber/white; red, green and gold/blue are taken by bugs,
// Greptiles and NPCs respectively.
const BEACON_HEIGHT = 34;
const BEACON_WIDTH = 0.5;
const BEACON_BASE_Y = 1.5;
const BEACON_COLOR = '#ffb01f';
// Thin the column down as you walk up to it — at arm's length a full-width
// beacon is just a wall of amber across the car you're trying to look at.
// Same trick as the bug beacons in Bugs.jsx.
const BEACON_FADE_DIST = 9;
const BEACON_MIN_WIDTH_MUL = 0.3;

// Collision spatial hash, same cell size and numeric-key scheme as Player.jsx.
const CELL = 8;
const KEY_OFF = 2048;
const KEY_SPAN = 4096;
function cellKey(cx, cz) {
  return (cx + KEY_OFF) * KEY_SPAN + (cz + KEY_OFF);
}

/* ------------------------------------------------------------------ */
/* Shared geometry + materials (module singletons, never per-entity)   */
/* ------------------------------------------------------------------ */

const VOXEL_GEOM = getVoxelGeometry();

// One Lambert material per paint color, created on first use. vertexColors is
// on so the geometry's baked per-face shading still reads.
const _bodyMaterials = new Map();
function getBodyMaterial(hex) {
  let m = _bodyMaterials.get(hex);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color: hex, vertexColors: true });
    _bodyMaterials.set(hex, m);
  }
  return m;
}

let _glassMat = null;
function getGlassMaterial() {
  if (!_glassMat) _glassMat = new THREE.MeshLambertMaterial({ color: '#dfeaf2', vertexColors: true });
  return _glassMat;
}

let _wheelMat = null;
function getWheelMaterial() {
  if (!_wheelMat) _wheelMat = new THREE.MeshLambertMaterial({ color: '#1c1c1c', vertexColors: true });
  return _wheelMat;
}

// Headlights and beacon are unlit — no vertexColors, so they read as flat glow
// rather than shaded blocks (same trick as StreetProps' lamp heads).
let _lightMat = null;
function getLightMaterial() {
  if (!_lightMat) _lightMat = new THREE.MeshBasicMaterial({ color: '#fff4c9' });
  return _lightMat;
}

let _beaconMat = null;
function getBeaconMaterial() {
  if (!_beaconMat) {
    _beaconMat = new THREE.MeshBasicMaterial({
      color: BEACON_COLOR,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }
  return _beaconMat;
}

let _shadowMat = null;
function getShadowMaterial() {
  if (!_shadowMat) {
    _shadowMat = new THREE.MeshBasicMaterial({
      color: '#000000', transparent: true, opacity: 0.26, depthWrite: false,
    });
  }
  return _shadowMat;
}

/**
 * One voxel block. `position` is the block's CENTER; the shared geometry is
 * bottom-pivoted (Ground.jsx translates it +0.5), so we subtract half the
 * height to get the base the mesh actually wants. Same helper shape as
 * Greptile.jsx's <Box>.
 */
function Box({ material, position, size }) {
  const [px, py, pz] = position;
  const [, sy] = size;
  return (
    <mesh geometry={VOXEL_GEOM} material={material} position={[px, py - sy / 2, pz]} scale={size} />
  );
}

/* ------------------------------------------------------------------ */
/* The car rig — local space, nose pointing -Z                         */
/* ------------------------------------------------------------------ */

const BODY_H = 0.62;
const BODY_BASE = 0.32;
const CAB_H = 0.5;
const CAB_LEN = 2.1;
const CAB_W = 1.5;
const WHEEL = 0.34;
const WHEEL_OFF_X = CAR_WIDTH * 0.35;
const WHEEL_OFF_Z = CAR_LENGTH * 0.32;

function CarBody({ color }) {
  const body = getBodyMaterial(color);
  return (
    <group>
      <Box material={body} position={[0, BODY_BASE + BODY_H / 2, 0]} size={[CAR_WIDTH, BODY_H, CAR_LENGTH]} />
      {/* cabin, set back from the nose */}
      <Box
        material={getGlassMaterial()}
        position={[0, BODY_BASE + BODY_H + CAB_H / 2 - 0.02, 0.3]}
        size={[CAB_W, CAB_H, CAB_LEN]}
      />
      {[[-WHEEL_OFF_X, -WHEEL_OFF_Z], [WHEEL_OFF_X, -WHEEL_OFF_Z],
        [-WHEEL_OFF_X, WHEEL_OFF_Z], [WHEEL_OFF_X, WHEEL_OFF_Z]].map(([wx, wz], i) => (
        <Box key={`w${i}`} material={getWheelMaterial()} position={[wx, 0.02 + WHEEL / 2, wz]} size={[WHEEL, WHEEL, WHEEL]} />
      ))}
      {/* headlights on the -Z nose */}
      {[-0.55, 0.55].map((lx, i) => (
        <Box key={`h${i}`} material={getLightMaterial()} position={[lx, BODY_BASE + BODY_H * 0.6, -CAR_LENGTH / 2 - 0.04]} size={[0.34, 0.24, 0.12]} />
      ))}
      {/* faked contact shadow — moving entities in this world cast none */}
      <mesh
        geometry={VOXEL_GEOM}
        material={getShadowMaterial()}
        position={[0, 0.005, 0]}
        scale={[CAR_WIDTH * 1.05, 0.02, CAR_LENGTH * 1.02]}
      />
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Scratch (module scope — zero per-frame allocation)                  */
/* ------------------------------------------------------------------ */

const _camTarget = new THREE.Vector3();
const _lookAt = new THREE.Vector3();

/* ------------------------------------------------------------------ */
/* Component                                                            */
/* ------------------------------------------------------------------ */

export default function Cars({ layout = null, spawn = null }) {
  const camera = useThree((s) => s.camera);
  const buildings = layout?.buildings;

  // Deterministic placement: same repo -> same three cars in the same spots.
  //
  // Keyed on the spawn COORDINATES, not the spawn object: the pipeline emits a
  // progressively-updated world several times per load and `assemble` calls
  // findSpawn afresh each time, so the object identity churns while the numbers
  // stay put. Depending on identity would re-place the cars — and eject you from
  // one mid-drive — every time Greptile's results landed.
  const spawnX = Number.isFinite(spawn?.x) ? spawn.x : 0;
  const spawnZ = Number.isFinite(spawn?.z) ? spawn.z : 0;
  const cars = useMemo(
    () => placeCars(layout, { x: spawnX, z: spawnZ }, CAR_COUNT),
    [layout, spawnX, spawnZ]
  );

  // Building spatial hash for car-vs-facade collision. Cars are wider than the
  // player, so footprints are expanded by CAR_RADIUS when bucketed.
  const grid = useMemo(() => {
    const g = new Map();
    const list = Array.isArray(buildings) ? buildings : [];
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.z)) continue;
      const hw = (b.w || 1) / 2 + CAR_RADIUS;
      const hd = (b.d || 1) / 2 + CAR_RADIUS;
      const x0 = Math.floor((b.x - hw) / CELL);
      const x1 = Math.floor((b.x + hw) / CELL);
      const z0 = Math.floor((b.z - hd) / CELL);
      const z1 = Math.floor((b.z + hd) / CELL);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const k = cellKey(cx, cz);
          let arr = g.get(k);
          if (!arr) { arr = []; g.set(k, arr); }
          arr.push(b);
        }
      }
    }
    return g;
  }, [buildings]);

  const groupRefs = useRef([]);
  const beaconRefs = useRef([]);
  const keys = useRef({ fwd: false, back: false, left: false, right: false, boost: false, brake: false });
  const drivingRef = useRef(null);       // the car object being driven, or null
  const nearRef = useRef(null);          // id of the nearest enterable car
  const proxAccRef = useRef(1);          // >interval so the first frame scans
  const [nearId, setNearId] = useState(null);
  const [drivingId, setDrivingId] = useState(null);
  const nearbyCollide = useRef([]);

  // Leaving the world while driving must not strand the flag set. (A new repo
  // remounts this component outright — App.jsx keys <SceneBoundary> by repo —
  // so there is no separate "cars changed" reset to do.)
  useEffect(() => () => {
    playerState.driving = false;
    playerState.nearbyCar = null;
  }, []);

  /* ---- input ---- */
  useEffect(() => {
    const k = keys.current;
    const down = (e) => {
      // A text field or modal panel owns the keyboard — "g" is a letter.
      if (playerState.typing || playerState.uiFocused) return;
      if (e.code === 'KeyG' && !e.repeat) {
        if (drivingRef.current) exitCar();
        else enterCar();
        return;
      }
      if (!drivingRef.current) return;
      switch (e.code) {
        case 'KeyW': case 'ArrowUp': k.fwd = true; break;
        case 'KeyS': case 'ArrowDown': k.back = true; break;
        case 'KeyA': case 'ArrowLeft': k.left = true; break;
        case 'KeyD': case 'ArrowRight': k.right = true; break;
        case 'ShiftLeft': case 'ShiftRight': k.boost = true; break;
        case 'Space': k.brake = true; break;
        default: return;
      }
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    };
    const up = (e) => {
      switch (e.code) {
        case 'KeyW': case 'ArrowUp': k.fwd = false; break;
        case 'KeyS': case 'ArrowDown': k.back = false; break;
        case 'KeyA': case 'ArrowLeft': k.left = false; break;
        case 'KeyD': case 'ArrowRight': k.right = false; break;
        case 'ShiftLeft': case 'ShiftRight': k.boost = false; break;
        case 'Space': k.brake = false; break;
        default: break;
      }
    };
    const blur = () => { k.fwd = k.back = k.left = k.right = k.boost = k.brake = false; };

    function enterCar() {
      const id = playerState.nearbyCar;
      if (id == null) return;
      const car = cars.find((c) => c.id === id);
      if (!car) return;
      car.speed = 0;
      drivingRef.current = car;
      playerState.driving = true;
      playerState.nearbyCar = null;
      nearRef.current = null;
      setNearId(null);
      setDrivingId(car.id);
    }

    function exitCar() {
      const car = drivingRef.current;
      drivingRef.current = null;
      playerState.driving = false;
      setDrivingId(null);
      blur();
      if (!car) return;
      car.speed = 0;
      const spot = exitPosition(car, Array.isArray(buildings) ? buildings : []);
      camera.position.set(spot.x, EYE_HEIGHT, spot.z);
      playerState.x = spot.x;
      playerState.y = EYE_HEIGHT;
      playerState.z = spot.z;
      // Standing next to the car you just left should re-offer it immediately.
      playerState.nearbyCar = car.id;
      nearRef.current = car.id;
      setNearId(car.id);
      proxAccRef.current = 1;
    }

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [cars, buildings, camera]);

  /* ---- simulation ---- */
  useFrame((_, delta) => {
    const dt = delta || 0;
    const driving = drivingRef.current;

    if (driving) {
      const k = keys.current;
      // Input is only taken while the pointer is locked, matching Player.jsx —
      // otherwise the car keeps rolling under a menu.
      const active = playerState.locked && !playerState.uiFocused;
      const throttle = active ? (k.fwd ? 1 : 0) + (k.back ? -1 : 0) : 0;
      const steer = active ? (k.right ? 1 : 0) + (k.left ? -1 : 0) : 0;

      stepVehicle(driving, {
        throttle,
        steer,
        boost: active && k.boost,
        handbrake: active && k.brake,
      }, dt);

      // Collide against buildings in the 9 cells around the car.
      const list = nearbyCollide.current;
      list.length = 0;
      const ccx = Math.floor(driving.x / CELL);
      const ccz = Math.floor(driving.z / CELL);
      for (let cx = ccx - 1; cx <= ccx + 1; cx++) {
        for (let cz = ccz - 1; cz <= ccz + 1; cz++) {
          const arr = grid.get(cellKey(cx, cz));
          if (arr) for (let i = 0; i < arr.length; i++) list.push(arr[i]);
        }
      }
      resolveCarCollision(driving, list);

      // Chase camera: behind and above, easing into place.
      const h = headingVector(driving.yaw);
      _camTarget.set(
        driving.x - h.x * CAM_BACK,
        CAM_HEIGHT,
        driving.z - h.z * CAM_BACK
      );
      const blend = 1 - Math.exp(-CAM_LERP * Math.min(dt, 0.05));
      camera.position.lerp(_camTarget, blend);
      if (camera.position.y < CAM_MIN_Y) camera.position.y = CAM_MIN_Y;
      _lookAt.set(
        driving.x + h.x * CAM_LOOK_AHEAD,
        CAM_LOOK_HEIGHT,
        driving.z + h.z * CAM_LOOK_AHEAD
      );
      camera.lookAt(_lookAt);

      // Player.jsx is stood down, so publish the shared state ourselves —
      // NPC proximity, the minimap and building focus all read these.
      playerState.x = driving.x;
      playerState.y = camera.position.y;
      playerState.z = driving.z;
      playerState.yaw = driving.yaw;
      playerState.focusedBuilding = null;
      playerState.focusedDistance = Infinity;
    } else {
      // Throttled proximity scan for the "press G to drive" prompt.
      proxAccRef.current += dt;
      if (proxAccRef.current >= PROXIMITY_INTERVAL) {
        proxAccRef.current = 0;
        let id = null;
        if (!playerState.uiFocused) {
          const hit = nearestCar(cars, playerState.x, playerState.z, ENTER_RADIUS);
          id = hit ? hit.car.id : null;
        }
        if (id !== nearRef.current) {
          nearRef.current = id;
          playerState.nearbyCar = id;
          setNearId(id);
        }
      }
    }

    // Push every car's transform to its group (3 cars — no culling needed).
    for (let i = 0; i < cars.length; i++) {
      const g = groupRefs.current[i];
      if (!g) continue;
      const c = cars[i];
      g.position.set(c.x, 0, c.z);
      g.rotation.y = c.yaw;
      const beacon = beaconRefs.current[i];
      // The beacon is a "come find me" marker; hide it on the car you're in.
      if (beacon) {
        const show = driving !== c;
        beacon.visible = show;
        if (show) {
          const d = Math.hypot(c.x - playerState.x, c.z - playerState.z);
          const mul = BEACON_MIN_WIDTH_MUL +
            (1 - BEACON_MIN_WIDTH_MUL) * Math.min(1, d / BEACON_FADE_DIST);
          beacon.scale.set(BEACON_WIDTH * mul, BEACON_HEIGHT, BEACON_WIDTH * mul);
        }
      }
    }
  });

  if (!cars.length) return null;

  return (
    <group>
      {cars.map((car, i) => (
        <group key={car.id} ref={(el) => { groupRefs.current[i] = el; }} position={[car.x, 0, car.z]} rotation={[0, car.yaw, 0]}>
          <CarBody color={car.color} />
          <mesh
            ref={(el) => { beaconRefs.current[i] = el; }}
            geometry={VOXEL_GEOM}
            material={getBeaconMaterial()}
            position={[0, BEACON_BASE_Y, 0]}
            scale={[BEACON_WIDTH, BEACON_HEIGHT, BEACON_WIDTH]}
          />
          {nearId === car.id && drivingId === null ? (
            <Billboard position={[0, 3.1, 0]}>
              <Text
                fontSize={0.34}
                color="#fff2cf"
                outlineWidth={0.03}
                outlineColor="#2b1d0e"
                anchorX="center"
                anchorY="middle"
              >
                press G to drive
              </Text>
            </Billboard>
          ) : null}
        </group>
      ))}
    </group>
  );
}
