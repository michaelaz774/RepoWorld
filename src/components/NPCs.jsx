/**
 * NPCs — the townsfolk who teach the player the codebase.
 *
 * Rendered as blocky Minecraft-style humanoids (VOXEL.md): one shared
 * BoxGeometry (`getVoxelGeometry` from Ground.jsx, the same geometry the
 * rest of the world uses, complete with its baked per-face shading) driving
 * ONE THREE.InstancedMesh for every body part of every NPC — head, torso,
 * 2 arms, 2 legs, 6 boxes per NPC, one draw call total. Skin/outfit tint
 * comes from per-instance color; idle motion (a gentle bob + occasional
 * turn) is written straight into instance matrices in a single useFrame,
 * with zero per-frame allocation (all scratch objects are module-level).
 *
 * Proximity to the player is checked on a ~200ms throttle (not every
 * frame): within TALK_RADIUS it publishes `playerState.nearbyNpc` and shows
 * a billboarded "Press T to talk" prompt. `T` is used for talk rather than
 * `F` (fly toggle) or `E` (deploy Greptile on a bug) — both already bound
 * in Player.jsx / the bug-combat loop.
 *
 * Talking opens a single DOM dialogue box (a React portal into
 * document.body, styled by ./npc.css) — only one is ever mounted at a time.
 * Opening it sets `playerState.uiFocused = true` and releases pointer lock
 * (which in turn makes Player.jsx treat movement as inactive); closing it
 * OR unmounting this component always restores `uiFocused = false`, so a
 * stuck dialogue can never freeze the player. `onTalk(npcId)` fires the
 * moment a conversation starts, so the integrator can record quest
 * progress even if the player doesn't click through every line.
 *
 * A floating marker above an NPC's head follows the brief's convention:
 * `!` for a quest that hasn't been progressed yet, `?` for one already
 * in progress, nothing once it's done or if the NPC has no quest at all.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { createPortal } from 'react-dom';
import { useFrame } from '@react-three/fiber';
import { Billboard, Text } from '@react-three/drei';
import { playerState } from '../lib/playerState.js';
import { activeQuests } from '../lib/quests.js';
import { getVoxelGeometry, hashStr, mulberry32 } from './Ground.jsx';
import './npc.css';

// Widened after playtesting: at 4 units you had to walk almost exactly onto an NPC, and
// since NPCs are spread across a ~240-unit city (nearest one ~57 units from spawn) the talk
// key just looked broken. Being generous here costs nothing — the prompt only shows for the
// single nearest NPC anyway.
const TALK_RADIUS = 12;
const TALK_RADIUS_SQ = TALK_RADIUS * TALK_RADIUS;
const PROXIMITY_INTERVAL = 0.2; // seconds
const BOB_SPEED = 1.6;
const BOB_AMP = 0.045;
const TURN_SPEED = 0.22;
const TURN_AMP = 0.22;

const SKIN_TONES = ['#e8b48a', '#c98a5a', '#8a5a34', '#f2c9a0'];

/** Local body-part layout: offsets from the NPC's root (x/z), the part's
 *  BASE y (geometry pivots at its bottom face, same convention as
 *  Buildings.jsx/Ground.jsx), its box size, and which tint it uses. */
const PARTS = [
  { key: 'legL', ox: -0.14, oz: 0, baseY: 0, sx: 0.22, sy: 0.8, sz: 0.22, tint: 'outfitDark' },
  { key: 'legR', ox: 0.14, oz: 0, baseY: 0, sx: 0.22, sy: 0.8, sz: 0.22, tint: 'outfitDark' },
  { key: 'torso', ox: 0, oz: 0, baseY: 0.8, sx: 0.5, sy: 0.7, sz: 0.28, tint: 'outfit' },
  { key: 'armL', ox: -0.34, oz: 0, baseY: 0.85, sx: 0.18, sy: 0.65, sz: 0.18, tint: 'skin' },
  { key: 'armR', ox: 0.34, oz: 0, baseY: 0.85, sx: 0.18, sy: 0.65, sz: 0.18, tint: 'skin' },
  { key: 'head', ox: 0, oz: 0, baseY: 1.5, sx: 0.4, sy: 0.4, sz: 0.4, tint: 'skin' },
];
const PARTS_COUNT = PARTS.length;

/* ------------------------------------------------------------------ */
/* Scratch objects reused every frame — never allocate inside useFrame */
/* ------------------------------------------------------------------ */
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);
const _color = new THREE.Color();
const _black = new THREE.Color('#000000');

let _humanoidMat = null;
function getHumanoidMaterial() {
  if (!_humanoidMat) {
    // vertexColors picks up the shared geometry's baked per-face shading;
    // instanceColor (set below) multiplies in the skin/outfit tint.
    _humanoidMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  }
  return _humanoidMat;
}

function skinToneFor(seedKey) {
  const rand = mulberry32(hashStr(seedKey + '-skin'));
  const idx = Math.floor(rand() * SKIN_TONES.length) % SKIN_TONES.length;
  return SKIN_TONES[idx];
}

function darkenHex(hex, amt) {
  _color.set(hex || '#4c8c5b');
  _color.lerp(_black, amt);
  return '#' + _color.getHexString();
}

/* ------------------------------------------------------------------ */
/* Dialogue box — a single DOM overlay, portaled to document.body      */
/* ------------------------------------------------------------------ */

function DialogueBox({ npc, lineIndex, onNext, onClose }) {
  const lines = Array.isArray(npc.lines) ? npc.lines : [];
  const line = lines[lineIndex] || '';
  const isLast = lineIndex >= lines.length - 1;
  return (
    <div className="npc-dialogue-backdrop">
      <div className="npc-dialogue-box">
        <p className="npc-dialogue-name">
          {npc.name || 'Local'} <span className="npc-dialogue-role">· {npc.role || 'Resident'}</span>
        </p>
        <p className="npc-dialogue-text">{line}</p>
        <div className="npc-dialogue-actions">
          <button type="button" className="npc-dialogue-btn" onClick={isLast ? onClose : onNext}>
            {isLast ? 'Close' : 'Next ▸'}
          </button>
          <span className="npc-dialogue-hint">[T] continue &middot; [Esc] close</span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Component                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {{npcs?: Object[], questState?: Object|null, onTalk?: ((npcId: string) => void)|null}} props
 */
export default function NPCs({ npcs = [], questState = null, onTalk = null }) {
  const list = useMemo(() => (Array.isArray(npcs) ? npcs.filter((n) => n && n.id != null) : []), [npcs]);

  // Exposed for debugging/automated testing, mirroring Scene.jsx's window.__chase.
  useEffect(() => {
    if (typeof window !== 'undefined') window.__npcs = list;
  }, [list]);

  // --- instanced humanoid bodies: built once per npc list, colors set once ---
  const { mesh, npcMeta } = useMemo(() => {
    const n = list.length;
    const m = new THREE.InstancedMesh(getVoxelGeometry(), getHumanoidMaterial(), Math.max(n * PARTS_COUNT, 1));
    m.count = n * PARTS_COUNT;
    m.frustumCulled = false; // one small draw call; never worth culling per-instance
    const meta = [];
    for (let i = 0; i < n; i++) {
      const npc = list[i];
      const seedKey = 'npcvis-' + npc.id;
      const rand = mulberry32(hashStr(seedKey));
      const phase = rand() * Math.PI * 2;
      const skin = skinToneFor(seedKey);
      const outfit = npc.outfitColor || '#4c8c5b';
      const outfitDark = darkenHex(outfit, 0.35);
      for (let p = 0; p < PARTS_COUNT; p++) {
        const part = PARTS[p];
        const hex = part.tint === 'skin' ? skin : part.tint === 'outfitDark' ? outfitDark : outfit;
        _color.set(hex);
        m.setColorAt(i * PARTS_COUNT + p, _color);
      }
      meta.push({
        id: npc.id,
        baseX: Number.isFinite(npc.x) ? npc.x : 0,
        baseZ: Number.isFinite(npc.z) ? npc.z : 0,
        phase,
      });
    }
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    return { mesh: m, npcMeta: meta };
  }, [list]);

  useEffect(() => () => mesh.dispose(), [mesh]);

  // --- proximity / talk state ---
  const [nearNpcId, setNearNpcId] = useState(null);
  const nearRef = useRef(null);
  const proxAccRef = useRef(1); // >interval so the first frame evaluates immediately

  const [activeNpc, setActiveNpc] = useState(null);
  const activeNpcRef = useRef(null);
  const [lineIndex, setLineIndex] = useState(0);
  const lineIndexRef = useRef(0);

  const openDialogue = (npc) => {
    activeNpcRef.current = npc;
    lineIndexRef.current = 0;
    setLineIndex(0);
    setActiveNpc(npc);
    playerState.uiFocused = true;
    playerState.nearbyNpc = null;
    nearRef.current = null;
    setNearNpcId(null);
    if (typeof document !== 'undefined' && typeof document.exitPointerLock === 'function') {
      document.exitPointerLock();
    }
    if (typeof onTalk === 'function') onTalk(npc.id);
  };

  const advanceDialogue = () => {
    const npc = activeNpcRef.current;
    if (!npc) return;
    const lines = Array.isArray(npc.lines) ? npc.lines : [];
    const next = lineIndexRef.current + 1;
    if (next >= lines.length) {
      closeDialogue();
    } else {
      lineIndexRef.current = next;
      setLineIndex(next);
    }
  };

  const closeDialogue = () => {
    activeNpcRef.current = null;
    setActiveNpc(null);
    playerState.uiFocused = false;
  };

  // Belt-and-suspenders: never leave the player frozen if this unmounts mid-dialogue.
  useEffect(() => () => {
    if (activeNpcRef.current) playerState.uiFocused = false;
  }, []);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.code === 'Escape') {
        if (activeNpcRef.current) closeDialogue();
        return;
      }
      if (e.code !== 'KeyT') return;
      if (activeNpcRef.current) {
        advanceDialogue();
        return;
      }
      // Another panel already has focus (e.g. a code/review panel) — stand down.
      if (playerState.uiFocused) return;
      if (playerState.nearbyNpc == null) return;
      const npc = list.find((n) => n.id === playerState.nearbyNpc);
      if (npc) openDialogue(npc);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  // --- per-frame: idle animation (every frame) + throttled proximity scan ---
  useFrame((state, dt) => {
    const t = state.clock.elapsedTime;
    for (let i = 0; i < npcMeta.length; i++) {
      const meta = npcMeta[i];
      const bob = Math.sin(t * BOB_SPEED + meta.phase) * BOB_AMP;
      const yaw = Math.sin(t * TURN_SPEED + meta.phase * 1.7) * TURN_AMP;
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      _quat.setFromAxisAngle(_up, yaw);
      for (let p = 0; p < PARTS_COUNT; p++) {
        const part = PARTS[p];
        const wx = meta.baseX + part.ox * cy - part.oz * sy;
        const wz = meta.baseZ + part.ox * sy + part.oz * cy;
        _pos.set(wx, part.baseY + bob, wz);
        _scale.set(part.sx, part.sy, part.sz);
        _mat.compose(_pos, _quat, _scale);
        mesh.setMatrixAt(i * PARTS_COUNT + p, _mat);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;

    proxAccRef.current += dt;
    if (proxAccRef.current < PROXIMITY_INTERVAL) return;
    proxAccRef.current = 0;
    if (activeNpcRef.current || playerState.uiFocused) return; // a panel has focus; no prompts

    const px = playerState.x;
    const pz = playerState.z;
    let best = null;
    let bestD2 = Infinity;
    for (let i = 0; i < list.length; i++) {
      const npc = list[i];
      const dx = (Number.isFinite(npc.x) ? npc.x : 0) - px;
      const dz = (Number.isFinite(npc.z) ? npc.z : 0) - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 < TALK_RADIUS_SQ && d2 < bestD2) {
        bestD2 = d2;
        best = npc;
      }
    }
    const id = best ? best.id : null;
    if (id !== nearRef.current) {
      nearRef.current = id;
      playerState.nearbyNpc = id;
      setNearNpcId(id);
    }
  });

  // --- quest marker lookup (recomputed only when quest state actually changes) ---
  const questProgressById = useMemo(() => {
    const map = new Map();
    for (const q of activeQuests(questState)) map.set(q.id, q.progress);
    return map;
  }, [questState]);

  const markerFor = (npc) => {
    if (!npc.questId) return null;
    const p = questProgressById.get(npc.questId);
    if (!p) return null; // done, or quest unknown
    return p.current > 0 ? '?' : '!';
  };

  if (list.length === 0) return null;

  return (
    <group>
      <primitive object={mesh} />

      {list.map((npc) => {
        const marker = markerFor(npc);
        const x = Number.isFinite(npc.x) ? npc.x : 0;
        const z = Number.isFinite(npc.z) ? npc.z : 0;
        return (
          <group key={npc.id}>
            {marker && (
              <Billboard position={[x, 2.35, z]}>
                <Text
                  fontSize={0.55}
                  color={marker === '!' ? '#ffd23f' : '#8fd3ff'}
                  outlineWidth={0.045}
                  outlineColor="#2b1d0e"
                  anchorX="center"
                  anchorY="middle"
                >
                  {marker}
                </Text>
              </Billboard>
            )}
            <Billboard position={[x, 2.0, z]}>
              <Text
                fontSize={0.28}
                color="#fff7e6"
                outlineWidth={0.03}
                outlineColor="#2b1d0e"
                anchorX="center"
                anchorY="bottom"
              >
                {npc.name || 'Local'}
              </Text>
            </Billboard>
            {nearNpcId === npc.id && !activeNpc && (
              <Billboard position={[x, 2.65, z]}>
                <Text
                  fontSize={0.3}
                  color="#ffffff"
                  outlineWidth={0.035}
                  outlineColor="#000000"
                  anchorX="center"
                  anchorY="middle"
                >
                  Press T to talk
                </Text>
              </Billboard>
            )}
          </group>
        );
      })}

      {activeNpc && typeof document !== 'undefined'
        ? createPortal(
            <DialogueBox npc={activeNpc} lineIndex={lineIndex} onNext={advanceDialogue} onClose={closeDialogue} />,
            document.body
          )
        : null}
    </group>
  );
}
