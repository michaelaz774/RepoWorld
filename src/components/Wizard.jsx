/**
 * Wizard — the wise wizard: a voxel NPC whose conversation, and whose feet, are
 * driven by a live Claude agent.
 *
 * WHY THIS IS NOT AN NPC. `NPCs.jsx` packs every NPC into one InstancedMesh and
 * copies each one's position into `npcMeta` at build time; its beacon matrices
 * are written in a `useEffect` whose comment reads "Positions never change
 * (NPCs don't move)". The wizard walks, so it gets its own per-entity <group>,
 * the same shape Greptile.jsx uses. Keeping it out of `quests.js` also keeps
 * `generateNpcs` deterministic, which quests.test.js asserts.
 *
 * Movement: the agent calls move_to / follow_player, which set a target on the
 * mutable ref below; `stepWizardBody` (pure, in lib/wizard.js) steers toward it
 * at walking pace and collides with buildings, sliding along facades rather than
 * passing through them (unlike the Greptiles, which have no collision at all).
 *
 * He routes rather than walking blindly: move_to plans an A* path over the
 * sidewalk graph (`layout.paths`) and he walks it waypoint to waypoint, so a
 * building between him and the destination is walked AROUND rather than shoved
 * at. Collision is still there as the backstop for the last off-graph leg and
 * for anything the graph does not cover; if he genuinely cannot get there, he
 * gives up after STUCK_TIMEOUT rather than grinding at a wall.
 *
 * While the player is typing at him he stops where he is and turns to face them,
 * then carries on when they stop — see `listening` in stepWizardBody.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Billboard, Text } from '@react-three/drei';
import * as THREE from 'three';
import { getVoxelGeometry } from './Ground.jsx';
import { playerState } from '../lib/playerState.js';
import {
  stepWizardBody, buildPathGraph, planWizardRoute, shouldReplan, isAimedAtWizard,
  WIZARD_RADIUS, WIZARD_SCALE,
} from '../lib/wizard.js';

// He is enormous; standing close enough to talk should not mean standing inside
// his robe. Scales with him so the prompt appears at a sensible distance.
// Being in range is necessary but NOT sufficient — you must also be looking at
// him, or the prompt fires while you face the other way. See isAimedAtWizard.
const TALK_RADIUS = 7 * WIZARD_SCALE;
const PROXIMITY_INTERVAL = 0.2;   // seconds between "is the player near me" scans
const MAX_DT = 0.05;
const BOB_SPEED = 1.6;
const BOB_AMP = 0.06 * WIZARD_SCALE;

// Rainbow beacon: bugs own red, Greptiles green, NPCs gold/blue and cars amber,
// so the one column in the city that cycles every hue is unmistakably his.
const BEACON_HEIGHT = 64;
const BEACON_WIDTH = 0.6 * WIZARD_SCALE;
/** Rig height at scale 1 is ~3.4, so this starts the column just above the hat
 *  whatever the scale. */
const BEACON_BASE_Y = 3.4 * WIZARD_SCALE;
const BEACON_BANDS = 24;        // stacked voxel bands, one InstancedMesh
const BEACON_CYCLES = 4;        // full rainbows up the column. One cycle spread over
                                // the whole 64 units means neighbouring bands differ
                                // by a twenty-fourth of a hue, and from the ground you
                                // only ever see the nearest few — i.e. one flat colour.
                                // Repeating the spectrum makes it read as a rainbow
                                // from directly underneath as well as from across town.
const BEACON_SCROLL = 0.05;     // hue turns per second — slow shimmer, not a disco

/* ---- Gandalf proportions: he stands ~3.2 units, well over the 1.8 pedestrians
        and the player's 2-unit eye height, so you look UP at him. ---- */
const LEG_H = 0.86;
const LEG_W = 0.2;
const HIP_Y = LEG_H;
const ROBE_H = 1.5;             // long tunic, overlapping the legs
const ROBE_BASE = 0.52;
const ROBE_TOP = ROBE_BASE + ROBE_H;   // 2.02
const SHOULDER_Y = ROBE_TOP - 0.1;
const ARM_H = 0.86;
const ARM_W = 0.2;
const ARM_X = 0.41;
const HEAD_SIZE = 0.44;
const HEAD_BASE = ROBE_TOP;
const BEARD_TOP = HEAD_BASE + 0.06;
const BEARD_H = 0.78;           // long enough to read as Gandalf from a distance
const HAT_BRIM_Y = HEAD_BASE + HEAD_SIZE;
const STAFF_H = 2.5;

const SWING_AMP = 0.62;         // radians — matches the pedestrians' gait
const ARM_SWING_RATIO = 0.45;   // damped: he is carrying a staff, not jogging
const SWING_EASE = 7;           // how fast limbs settle when he stops

// Building spatial hash, same cell size and numeric-key scheme as Player/Cars.
const CELL = 8;
const KEY_OFF = 2048;
const KEY_SPAN = 4096;
function cellKey(cx, cz) {
  return (cx + KEY_OFF) * KEY_SPAN + (cz + KEY_OFF);
}

const VOXEL_GEOM = getVoxelGeometry();

/* ---- materials: module singletons, never per-entity ---- */
const mats = {};
function mat(key, hex, opts = {}) {
  if (!mats[key]) mats[key] = new THREE.MeshLambertMaterial({ color: hex, vertexColors: true, ...opts });
  return mats[key];
}
let _beaconMat = null;
function beaconMaterial() {
  if (!_beaconMat) {
    _beaconMat = new THREE.MeshBasicMaterial({
      // White base: the per-instance colour supplies every hue. Alpha-blended,
      // never additive — additive washes out to white against a bright sky,
      // which is exactly what a rainbow must not do (see Bugs.jsx).
      color: '#ffffff', transparent: true, opacity: 0.8,
      depthWrite: false, side: THREE.DoubleSide,
    });
  }
  return _beaconMat;
}
let _shadowMat = null;
function shadowMaterial() {
  if (!_shadowMat) {
    _shadowMat = new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.26, depthWrite: false });
  }
  return _shadowMat;
}
let _starMat = null;
function starMaterial() {
  if (!_starMat) _starMat = new THREE.MeshBasicMaterial({ color: '#ffe9a8' });
  return _starMat;
}

/** Bottom-pivot voxel box; `position` is the block's centre (see Ground.jsx). */
function Box({ material, position, size }) {
  const [px, py, pz] = position;
  const [, sy] = size;
  return <mesh geometry={VOXEL_GEOM} material={material} position={[px, py - sy / 2, pz]} scale={size} />;
}

/**
 * Robe, long beard, wide hat, staff. Faces -Z, matching the yaw convention.
 *
 * Legs and arms hang from pivot GROUPS at the hip and shoulder so a rotation
 * about X swings them from the top, the same stiff Minecraft gait Pedestrians.jsx
 * uses (arms counter-phase to legs). The staff is parented to the right arm so
 * it sways with him instead of floating.
 */
function WizardRig({ legLRef, legRRef, armLRef, armRRef }) {
  const robe = mat('robe', '#4a3b8f');
  const trim = mat('trim', '#2e2560');
  const skin = mat('skin', '#e8b98f');
  const beard = mat('beard', '#e8e6ef');
  const wood = mat('wood', '#7a5636');
  return (
    <group>
      {/* legs — only the lower half shows below the hem, which is all Gandalf needs */}
      <group ref={legLRef} position={[-0.17, HIP_Y, 0]}>
        <Box material={trim} position={[0, -LEG_H / 2, 0]} size={[LEG_W, LEG_H, LEG_W]} />
      </group>
      <group ref={legRRef} position={[0.17, HIP_Y, 0]}>
        <Box material={trim} position={[0, -LEG_H / 2, 0]} size={[LEG_W, LEG_H, LEG_W]} />
      </group>

      {/* robe */}
      <Box material={robe} position={[0, ROBE_BASE + ROBE_H / 2, 0]} size={[0.68, ROBE_H, 0.5]} />
      <Box material={trim} position={[0, ROBE_BASE + 0.06, 0]} size={[0.76, 0.12, 0.58]} />
      <Box material={trim} position={[0, SHOULDER_Y - 0.16, 0]} size={[0.74, 0.2, 0.56]} />

      {/* arms */}
      <group ref={armLRef} position={[-ARM_X, SHOULDER_Y, 0]}>
        <Box material={robe} position={[0, -ARM_H / 2, 0]} size={[ARM_W, ARM_H, ARM_W]} />
      </group>
      <group ref={armRRef} position={[ARM_X, SHOULDER_Y, 0]}>
        <Box material={robe} position={[0, -ARM_H / 2, 0]} size={[ARM_W, ARM_H, ARM_W]} />
        {/* staff, held in the right hand */}
        <Box material={wood} position={[0.12, -ARM_H + STAFF_H / 2 - 0.15, 0.06]} size={[0.11, STAFF_H, 0.11]} />
        <mesh
          geometry={VOXEL_GEOM}
          material={starMaterial()}
          position={[0.12, -ARM_H + STAFF_H - 0.15, 0.06]}
          scale={[0.24, 0.24, 0.24]}
        />
      </group>

      {/* head + long beard */}
      <Box material={skin} position={[0, HEAD_BASE + HEAD_SIZE / 2, 0]} size={[HEAD_SIZE, HEAD_SIZE, 0.4]} />
      <Box material={beard} position={[0, BEARD_TOP - BEARD_H / 2, -0.17]} size={[0.32, BEARD_H, 0.14]} />
      <Box material={beard} position={[0, HEAD_BASE + HEAD_SIZE - 0.06, 0]} size={[0.46, 0.12, 0.42]} />

      {/* hat: brim then a stepped cone */}
      <Box material={trim} position={[0, HAT_BRIM_Y + 0.05, 0]} size={[0.94, 0.1, 0.94]} />
      <Box material={robe} position={[0, HAT_BRIM_Y + 0.22, 0]} size={[0.48, 0.26, 0.48]} />
      <Box material={robe} position={[0, HAT_BRIM_Y + 0.44, 0]} size={[0.32, 0.2, 0.32]} />
      <Box material={robe} position={[0, HAT_BRIM_Y + 0.62, 0]} size={[0.18, 0.18, 0.18]} />
      <mesh
        geometry={VOXEL_GEOM}
        material={starMaterial()}
        position={[0, HAT_BRIM_Y + 0.7, 0]}
        scale={[0.11, 0.11, 0.11]}
      />

      {/* faked contact shadow — moving entities in this world cast none */}
      <mesh
        geometry={VOXEL_GEOM}
        material={shadowMaterial()}
        position={[0, 0.005, 0]}
        scale={[0.9, 0.02, 0.75]}
      />
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Rainbow beacon                                                      */
/* ------------------------------------------------------------------ */

const _beaconPos = new THREE.Vector3();
const _beaconScale = new THREE.Vector3();
const _beaconMat4 = new THREE.Matrix4();
const _beaconQuat = new THREE.Quaternion();
const _beaconColor = new THREE.Color();
// targeting.js takes a plain {x,y,z,dirX,dirY,dirZ}, not a THREE.Camera.
const _camDir = new THREE.Vector3();
const _camPlain = { x: 0, y: 0, z: 0, dirX: 0, dirY: 0, dirZ: -1 };

/**
 * One InstancedMesh of stacked voxel bands, hue-cycled. Instancing (rather than
 * 18 meshes) matches how every other repeated thing in this world is drawn, and
 * the hard-edged bands keep it voxel rather than a smooth gradient.
 */
function buildBeaconMesh() {
  const m = new THREE.InstancedMesh(VOXEL_GEOM, beaconMaterial(), BEACON_BANDS);
  m.frustumCulled = false;
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const bandH = BEACON_HEIGHT / BEACON_BANDS;
  for (let i = 0; i < BEACON_BANDS; i++) {
    _beaconPos.set(0, BEACON_BASE_Y + i * bandH, 0);
    _beaconScale.set(BEACON_WIDTH, bandH, BEACON_WIDTH);
    _beaconMat4.compose(_beaconPos, _beaconQuat, _beaconScale);
    m.setMatrixAt(i, _beaconMat4);
    // Eagerly set every colour so instanceColor exists before the frame loop
    // ever reads it (see the Bugs.jsx/NPCs.jsx note on that trap).
    _beaconColor.setHSL((i / BEACON_BANDS) * BEACON_CYCLES % 1, 0.95, 0.52);
    m.setColorAt(i, _beaconColor);
  }
  m.instanceMatrix.needsUpdate = true;
  if (m.instanceColor) m.instanceColor.needsUpdate = true;
  return m;
}

/**
 * @param {Object} props
 * @param {{x:number,z:number}} props.home  where the wizard first stands
 * @param {Object} props.controlRef         ref the agent's tools write targets into
 * @param {boolean} props.chatOpen
 * @param {string|null} props.status        transient status line ("reading src/a.js…")
 */
export default function Wizard({
  home = null,
  buildings = null,
  paths = null,
  chase = null,
  controlRef = null,
  chatOpen = false,
  status = null,
}) {
  const camera = useThree((s) => s.camera);
  const groupRef = useRef(null);
  const legLRef = useRef(null);
  const legRRef = useRef(null);
  const armLRef = useRef(null);
  const armRRef = useRef(null);
  const swingRef = useRef(0);      // eased 0..1 "how much gait" — no popping on stop
  const proxAcc = useRef(1);
  const nearRef = useRef(false);
  const [near, setNear] = useState(false);

  // Mutable body state — mutated by tools and by useFrame, never React state.
  const body = useRef({ x: 0, z: 0, yaw: 0, targetX: null, targetZ: null, following: false });

  // Collision candidates, bucketed once per layout — the frame loop only ever
  // looks at the 9 cells around him, never the whole city.
  const grid = useMemo(() => {
    const g = new Map();
    const list = Array.isArray(buildings) ? buildings : [];
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.z)) continue;
      const hw = (b.w || 1) / 2 + WIZARD_RADIUS;
      const hd = (b.d || 1) / 2 + WIZARD_RADIUS;
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
  const nearbyBuildings = useRef([]);
  const buildingList = useMemo(() => (Array.isArray(buildings) ? buildings : []), [buildings]);

  // The navigation graph. Built once per layout — 594 nodes on the demo city, so
  // planning is cheap, but not something to redo every frame.
  const pathGraph = useMemo(() => buildPathGraph(paths), [paths]);
  const replanAcc = useRef(0);
  const chaseRef = useRef(null);        // creature id he is chasing, or null
  const plannedForRef = useRef(null);   // where the current route was aimed
  const chaseStateRef = useRef(chase);
  chaseStateRef.current = chase;

  const beaconMesh = useMemo(() => buildBeaconMesh(), []);
  useEffect(() => () => beaconMesh.dispose(), [beaconMesh]);

  const spawn = useMemo(() => ({
    x: Number.isFinite(home?.x) ? home.x : 0,
    z: Number.isFinite(home?.z) ? home.z : 0,
  }), [home]);

  useEffect(() => {
    const b = body.current;
    b.x = spawn.x; b.z = spawn.z;
    b.targetX = null; b.targetZ = null; b.following = false;
  }, [spawn]);

  // Publish the control surface the agent's tools call into.
  useEffect(() => {
    if (!controlRef) return undefined;
    controlRef.current = {
      moveTo(x, z) {
        const b = body.current;
        if (!Number.isFinite(x) || !Number.isFinite(z)) return { error: 'move_to needs finite x and z' };
        b.targetX = x; b.targetZ = z; b.following = false;
        b.blocked = false; b.stuckFor = 0;
        // The full building list, not the 9-cell collision candidates: routing
        // has to know about everything between here and there.
        b.route = planWizardRoute(pathGraph, b.x, b.z, x, z, buildingList);
        b.routeIndex = 0;
        return {
          moving: true,
          to: { x, z },
          from: { x: Math.round(b.x), z: Math.round(b.z) },
          waypoints: b.route.length,
        };
      },
      chaseCreature(id) {
        const b = body.current;
        chaseRef.current = id || null;
        plannedForRef.current = null;
        b.following = false;
        b.route = null;
        b.routeIndex = 0;
        b.blocked = false;
        b.stuckFor = 0;
        if (!id) { b.targetX = null; b.targetZ = null; }
      },
      setFollow(on) {
        const b = body.current;
        b.following = !!on;
        chaseRef.current = null;
        b.route = null;
        b.routeIndex = 0;
        if (on) { b.targetX = null; b.targetZ = null; }
      },
      position() {
        const b = body.current;
        return {
          x: b.x, z: b.z, following: b.following, blocked: !!b.blocked,
          chasing: chaseRef.current || null,
          enRoute: Array.isArray(b.route) ? b.route.length - (b.routeIndex || 0) : 0,
        };
      },
    };
    // Exposed for debugging/automated testing of the wizard's movement from the
    // console, the same way Scene.jsx exposes window.__chase.
    if (typeof window !== 'undefined') window.__wizard = controlRef.current;
    return () => {
      controlRef.current = null;
      if (typeof window !== 'undefined') window.__wizard = null;
    };
  }, [controlRef, pathGraph, buildingList]);

  useFrame((state, delta) => {
    const dt = Math.min(delta || 0, MAX_DT);
    const b = body.current;

    // All the steering lives in lib/wizard.js so it can be unit-tested; this
    // component only supplies live inputs and draws the result.
    // Gather the 9 cells around him as collision candidates.
    const cands = nearbyBuildings.current;
    cands.length = 0;
    const ccx = Math.floor(b.x / CELL);
    const ccz = Math.floor(b.z / CELL);
    for (let cx = ccx - 1; cx <= ccx + 1; cx++) {
      for (let cz = ccz - 1; cz <= ccz + 1; cz++) {
        const arr = grid.get(cellKey(cx, cz));
        if (arr) for (let i = 0; i < arr.length; i++) cands.push(arr[i]);
      }
    }

    // Chasing something that roams: steer at where it IS, and redraw the route
    // only when it has wandered far enough from where the route was aimed.
    let liveTarget = null;
    if (chaseRef.current) {
      const cs = chaseStateRef.current;
      const quarry = (cs?.greptiles || []).find((g) => g && g.id === chaseRef.current)
        || (cs?.bugs || []).find((bg) => bg && bg.id === chaseRef.current && bg.state !== 'dead');
      if (!quarry) {
        // It died or vanished — stop rather than walking at a ghost.
        chaseRef.current = null;
        plannedForRef.current = null;
        b.targetX = null; b.targetZ = null; b.route = null; b.routeIndex = 0;
      } else {
        liveTarget = { x: quarry.x, z: quarry.z };
        if (shouldReplan(plannedForRef.current, quarry.x, quarry.z)) {
          plannedForRef.current = { x: quarry.x, z: quarry.z };
          b.route = planWizardRoute(pathGraph, b.x, b.z, quarry.x, quarry.z, buildingList);
          b.routeIndex = 0;
          b.blocked = false;
        }
      }
    }

    // Following walks straight at the player, which is right almost always —
    // but if a building gets between them he would shove at it forever. Re-plan
    // a route round it, throttled so this is not an A* per frame.
    replanAcc.current += dt;
    if (b.following && b.blocked && !b.route && replanAcc.current > 1.5) {
      replanAcc.current = 0;
      b.route = planWizardRoute(pathGraph, b.x, b.z, playerState.x, playerState.z, buildingList);
      b.routeIndex = 0;
      b.blocked = false;
    }

    stepWizardBody(b, {
      playerX: playerState.x,
      playerZ: playerState.z,
      listening: playerState.typing,
      near: nearRef.current,
      buildings: cands,
      liveTarget,
    }, dt);

    // Publish his position so the minimap can mark him without prop drilling.
    playerState.wizardX = b.x;
    playerState.wizardZ = b.z;

    const g = groupRef.current;
    if (g) {
      const bob = Math.sin(state.clock.elapsedTime * BOB_SPEED) * BOB_AMP;
      g.position.set(b.x, bob, b.z);
      g.rotation.y = b.yaw;
    }

    // Gait: ease the amplitude in and out so limbs settle instead of snapping
    // to attention the frame he stops.
    const wantSwing = b.moving ? 1 : 0;
    swingRef.current += (wantSwing - swingRef.current) * Math.min(1, SWING_EASE * dt);
    const swing = Math.sin(b.phase || 0) * SWING_AMP * swingRef.current;
    if (legLRef.current) legLRef.current.rotation.x = swing;
    if (legRRef.current) legRRef.current.rotation.x = -swing;
    if (armLRef.current) armLRef.current.rotation.x = -swing * ARM_SWING_RATIO;
    if (armRRef.current) armRRef.current.rotation.x = swing * ARM_SWING_RATIO;

    // Rainbow: scroll the hue up the column, and thin it as you get close so it
    // is a landmark from across the city, not a wall of colour at his feet.
    beaconMesh.visible = !chatOpen;
    if (beaconMesh.visible) {
      const d = Math.hypot(b.x - playerState.x, b.z - playerState.z);
      const mul = 0.3 + 0.7 * Math.min(1, d / 14);
      const bandH = BEACON_HEIGHT / BEACON_BANDS;
      const scroll = state.clock.elapsedTime * BEACON_SCROLL;
      for (let i = 0; i < BEACON_BANDS; i++) {
        _beaconPos.set(b.x, BEACON_BASE_Y + i * bandH, b.z);
        _beaconScale.set(BEACON_WIDTH * mul, bandH, BEACON_WIDTH * mul);
        _beaconMat4.compose(_beaconPos, _beaconQuat, _beaconScale);
        beaconMesh.setMatrixAt(i, _beaconMat4);
        _beaconColor.setHSL(((i / BEACON_BANDS) * BEACON_CYCLES + scroll) % 1, 0.95, 0.52);
        beaconMesh.setColorAt(i, _beaconColor);
      }
      beaconMesh.instanceMatrix.needsUpdate = true;
      if (beaconMesh.instanceColor) beaconMesh.instanceColor.needsUpdate = true;
    }

    // Throttled proximity scan for the "press R" prompt.
    proxAcc.current += dt;
    if (proxAcc.current >= PROXIMITY_INTERVAL) {
      proxAcc.current = 0;
      let inRange = false;
      if (!playerState.uiFocused) {
        camera.getWorldDirection(_camDir);
        _camPlain.x = camera.position.x;
        _camPlain.y = camera.position.y;
        _camPlain.z = camera.position.z;
        _camPlain.dirX = _camDir.x;
        _camPlain.dirY = _camDir.y;
        _camPlain.dirZ = _camDir.z;
        inRange = isAimedAtWizard(_camPlain, b, { maxDistance: TALK_RADIUS });
      }
      if (inRange !== nearRef.current) {
        nearRef.current = inRange;
        playerState.nearbyWizard = inRange;
        setNear(inRange);
      }
    }
  });

  useEffect(() => () => { playerState.nearbyWizard = false; }, []);

  return (
    <>
      {/* The beacon is positioned in world space each frame rather than parented
          to the wizard, so his yaw never spins the column. */}
      <primitive object={beaconMesh} />
      <group ref={groupRef} position={[spawn.x, 0, spawn.z]}>
        {/* One scale on the whole rig: proportions, staff and contact shadow all
            grow together, and WIZARD_SCALE stays the single source of truth for
            how big he is (lib/wizard.js scales his physics off the same number). */}
        <group scale={WIZARD_SCALE}>
          <WizardRig legLRef={legLRef} legRRef={legRRef} armLRef={armLRef} armRRef={armRRef} />
        </group>
      {status ? (
        <Billboard position={[0, 3.6 * WIZARD_SCALE, 0]}>
          <Text fontSize={0.26 * WIZARD_SCALE} color="#d9c6ff" outlineWidth={0.02} outlineColor="#1a1030" anchorX="center" anchorY="middle">
            {status}
          </Text>
        </Billboard>
      ) : near && !chatOpen ? (
        <Billboard position={[0, 3.6 * WIZARD_SCALE, 0]}>
          <Text fontSize={0.3 * WIZARD_SCALE} color="#f2e9ff" outlineWidth={0.03} outlineColor="#1a1030" anchorX="center" anchorY="middle">
            press R to speak with the wizard
          </Text>
        </Billboard>
        ) : null}
      </group>
    </>
  );
}
