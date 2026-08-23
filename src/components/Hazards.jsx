/**
 * Hazards — bugs / stale PRs / risky files rendered as physical danger in the city.
 *
 * - 'issue' -> fire: additive billboarded flame quads + embers (Sparkles) +
 *   flickering point light + ground glow + translucent danger cylinder.
 * - 'pr'    -> churning amber vortex: two counter-rotating open cones ("work in flight").
 * - 'risk'  -> scanning beacon: pulsing red column of light rising from the roof
 *   with a scan pulse travelling up it (Greptile's verdict).
 *
 * Severity (1..10) drives flame size, ember count, light intensity, glow radius
 * and the color ramp (amber -> orange -> deep red + smoke).
 *
 * Performance rules honoured:
 * - Only the top ~20 hazards (by severity) get the fully-detailed effect
 *   (flame quads / lights / smoke / scan pulse); the rest get glow + sparkles.
 * - All canvas textures are generated exactly once and shared.
 * - Geometries are module-level singletons shared by every marker.
 * - One useFrame in the parent walks per-marker animation callbacks; zero
 *   allocation per frame (index loops, scratch-free math, no Math.random).
 * - Labels are distance-culled (~60u) on a 0.25s throttle, not every frame.
 *
 * Writes playerState.dangerLevel / activeHazard / hazardsVisited every frame.
 */
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Sparkles, Text } from '@react-three/drei';
import { playerState } from '../lib/playerState.js';

const DETAIL_CAP = 20;      // max fully-detailed fires
const LABEL_CULL_DIST = 60; // units
const CULL_INTERVAL = 0.25; // seconds between label-cull passes

// --- Distance LOD: forward-lit materials (MeshLambertMaterial) pay for every
// active light across the WHOLE scene every frame, not just near that light —
// so the single biggest lever here is capping how many real-time point lights
// can be on at once, picking whichever detailed hazards are actually nearest
// the player. Heavy overdraw layers (flame stacks / vortex cones) and the
// per-hazard Sparkles also go idle (visible=false, which skips their draw
// call entirely) once they're far enough to be visually negligible anyway.
const NEAR_LIGHT_CAP = 6;     // max concurrently-active real point lights
const EFFECT_CULL_DIST = 90;  // beyond this, flame/vortex quad stacks go idle
const EFFECT_CULL_DIST_SQ = EFFECT_CULL_DIST * EFFECT_CULL_DIST;
const SPARK_CULL_DIST = 130;  // beyond this, per-hazard Sparkles go idle
const SPARK_CULL_DIST_SQ = SPARK_CULL_DIST * SPARK_CULL_DIST;

/* ------------------------------------------------------------------ */
/* Shared singletons (created once per module load)                    */
/* ------------------------------------------------------------------ */

const QUAD = new THREE.PlaneGeometry(1, 1);
const DISC = new THREE.CircleGeometry(1, 24);
const TUBE = new THREE.CylinderGeometry(1, 1, 1, 16, 1, true);     // straight open tube
const CONE = new THREE.CylinderGeometry(0.45, 1, 1, 16, 1, true);  // open cone (vortex)

let _textures = null;
/** Canvas textures, generated once and shared by every hazard. White/alpha
 *  masks tinted via material.color. Returns nulls outside the browser. */
function getTextures() {
  if (_textures) return _textures;
  if (typeof document === 'undefined') {
    _textures = { flame: null, glow: null, smoke: null, beam: null };
    return _textures;
  }
  const make = (w, h, draw) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  };
  // Teardrop flame: hot core low-center, fading upward and outward.
  const flame = make(128, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const grd = g.createRadialGradient(w / 2, h * 0.72, 4, w / 2, h * 0.62, w * 0.62);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.85)');
    grd.addColorStop(0.7, 'rgba(255,255,255,0.32)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
    // taper the top so it reads as a flame tongue, not a blob
    const fade = g.createLinearGradient(0, 0, 0, h);
    fade.addColorStop(0, 'rgba(0,0,0,1)');
    fade.addColorStop(0.45, 'rgba(0,0,0,0.25)');
    fade.addColorStop(0.75, 'rgba(0,0,0,0)');
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = fade;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'source-over';
  });
  // Soft radial glow.
  const glow = make(128, 128, (g, w, h) => {
    const grd = g.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
    grd.addColorStop(0, 'rgba(255,255,255,0.9)');
    grd.addColorStop(0.5, 'rgba(255,255,255,0.28)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
  });
  // Puffy smoke blob.
  const smoke = make(128, 128, (g, w, h) => {
    const grd = g.createRadialGradient(w / 2, h / 2, 4, w / 2, h / 2, w / 2);
    grd.addColorStop(0, 'rgba(200,200,200,0.55)');
    grd.addColorStop(0.6, 'rgba(160,160,160,0.22)');
    grd.addColorStop(1, 'rgba(120,120,120,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
  });
  // Vertical beam: bright base fading to nothing at the top.
  const beam = make(32, 256, (g, w, h) => {
    const grd = g.createLinearGradient(0, h, 0, 0);
    grd.addColorStop(0, 'rgba(255,255,255,0.9)');
    grd.addColorStop(0.5, 'rgba(255,255,255,0.35)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
  });
  _textures = { flame, glow, smoke, beam };
  return _textures;
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/** FNV-1a — deterministic per-hazard offsets/phases (no Math.random). */
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function clampSev(s) {
  const n = Number(s);
  return Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : 1;
}

/** Severity color ramp: low = amber, mid = orange, high = deep red. */
function severityStyle(sev) {
  if (sev <= 3) return { core: '#fff3b0', mid: '#ffb347', glow: '#ff9a3c', text: '#ffd166' };
  if (sev <= 6) return { core: '#ffe0a3', mid: '#ff7b1f', glow: '#ff4d1f', text: '#ff9a3c' };
  return { core: '#ffc48a', mid: '#ff3b1f', glow: '#c9150a', text: '#ff4d4d' };
}

function labelText(h) {
  const title = String(h.title || h.id || '').slice(0, 48);
  if (h.kind === 'pr') return h.number != null ? `PR #${h.number} · ${title}` : `PR · ${title}`;
  if (h.kind === 'risk') return `RISK · ${title}`;
  return h.number != null ? `#${h.number} ${title}` : title;
}

/** Wrap a string to ~`width` chars/line, max `maxLines` lines. */
function wrapReason(s, width = 60, maxLines = 4) {
  const words = String(s || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const next = cur ? cur + ' ' + words[i] : words[i];
    if (next.length > width && cur) {
      lines.push(cur);
      cur = words[i];
      if (lines.length === maxLines) break;
    } else {
      cur = next;
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length > maxLines) lines.length = maxLines;
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    lines[maxLines - 1] = lines[maxLines - 1].slice(0, width - 1) + '…';
  }
  return lines.join('\n');
}

/** Precompute everything static about one placed hazard. */
function makeSlot(hazard, building, idxOnBuilding, detailed) {
  const sev = clampSev(hazard.severity);
  const hash = hashStr(String(hazard.id || ''));
  const ang = ((hash % 628) / 100);
  const spread = idxOnBuilding === 0
    ? 0
    : Math.min(building.w || 2, building.d || 2) * 0.35 + (idxOnBuilding - 1) * 0.35;
  return {
    hazard,
    building,
    id: hazard.id,
    kind: hazard.kind,
    severity: sev,
    detailed,
    x: (building.x || 0) + Math.cos(ang) * spread,
    z: (building.z || 0) + Math.sin(ang) * spread,
    radius: 2.5 + sev * 0.8,
    labelY: (building.height || 2) + 1.8 + idxOnBuilding * 1.5,
    roof: building.height || 2,
    phase: ((hash % 1000) / 1000) * Math.PI * 2,
    // filled by HazardMarker (mutable refs, walked by the parent loop)
    labelRef: { current: null },
    reasonRef: { current: null },
    // Distance LOD state, recomputed every frame by the parent's single loop
    // (zero extra cost — it already walks every slot to compute danger).
    distSq: Infinity,
    lightOn: false,
    effectOn: true,
    sparkOn: true,
  };
}

/* ------------------------------------------------------------------ */
/* Single hazard marker                                                */
/* ------------------------------------------------------------------ */

/**
 * One hazard's full visual. Usable standalone (own useFrame) or driven by the
 * parent <Hazards> single-loop registry.
 * @param {{hazard: import('../lib/types.js').Hazard, building: Object, slot?: Object, registry?: Object}} props
 */
export function HazardMarker({ hazard, building, slot: slotProp, registry }) {
  const slot = useMemo(
    () => slotProp || (hazard && building ? makeSlot(hazard, building, 0, true) : null),
    [slotProp, hazard, building]
  );
  const tex = useMemo(() => getTextures(), []);
  const refs = useRef({
    flames: [], smoke: [], flameGroup: null, light: null, glowMat: null,
    v1: null, v2: null, beamMat: null, scan: null, ring: null,
    sparkGroup: null, vortexGroup: null,
  });

  const spec = useMemo(() => {
    if (!slot) return null;
    const sev = slot.severity;
    const sty = severityStyle(sev);
    const fh = Math.max(1.4, Math.min((slot.roof || 4) * 0.75 + 0.8, 1.6 + sev * 0.75));
    return {
      sty,
      fh,
      flames: [
        { w: fh * 0.75, h: fh, y: fh * 0.5, color: sty.mid },
        { w: fh * 0.5, h: fh * 0.72, y: fh * 0.42, color: sty.glow },
        { w: fh * 0.32, h: fh * 0.48, y: fh * 0.3, color: sty.core },
      ],
      smokeBase: fh * 1.1,
      lightBase: 1.5 + sev * 2.2,
      glowR: slot.radius * 0.55,
      sparkCount: slot.detailed ? 12 + sev * 6 : 6 + sev * 2,
      vortexR: 0.8 + sev * 0.12,
      vortexH: 2 + sev * 0.45,
      beamR: 0.28 + sev * 0.05,
      beamH: 7 + sev * 1.3,
    };
  }, [slot]);

  // Latest anim closure, called by parent registry (or own useFrame fallback).
  const animRef = useRef(null);
  animRef.current = (t, dt, cam) => {
    if (!slot || !spec) return;
    const a = refs.current;
    const p = slot.phase;

    // --- distance LOD: cheap toggles computed once by the parent loop ---
    const lightOn = slot.lightOn;
    const effectOn = slot.effectOn;
    if (a.light) a.light.visible = lightOn;
    if (a.sparkGroup) a.sparkGroup.visible = slot.sparkOn;
    if (a.flameGroup) a.flameGroup.visible = effectOn;
    if (a.vortexGroup) a.vortexGroup.visible = effectOn;

    // billboard the label to the camera (cheap, always on)
    if (slot.labelRef.current && cam) slot.labelRef.current.quaternion.copy(cam.quaternion);

    // layered sines: smooth, deterministic flicker (no per-frame random).
    // Cheap enough to keep even at distance — it only drives the glow disc
    // opacity once effectOn/lightOn are both false below.
    const f = 0.86
      + 0.09 * Math.sin(t * 11 + p)
      + 0.05 * Math.sin(t * 23 + p * 1.7)
      + 0.04 * Math.sin(t * 5.1 + p * 0.6);
    if (a.glowMat) a.glowMat.opacity = 0.22 + 0.14 * f;

    // Everything below this line is the expensive per-hazard overdraw/light
    // work — skip it entirely once the hazard is far enough to be visually
    // negligible (this both saves the sine math and, via .visible above,
    // drops the draw calls).
    if (!effectOn && !lightOn) return;

    // Y-billboard the flame fan toward the camera
    if (a.flameGroup && cam && effectOn) {
      a.flameGroup.rotation.y = Math.atan2(cam.position.x - slot.x, cam.position.z - slot.z);
    }
    if (slot.kind === 'issue') {
      if (effectOn) {
        for (let i = 0; i < a.flames.length; i++) {
          const m = a.flames[i];
          const s = spec.flames[i];
          if (!m || !s) continue;
          const wob = f + 0.08 * Math.sin(t * (13 + i * 4) + p + i * 2.1);
          m.scale.set(s.w * wob, s.h * (0.88 * f + 0.16 * Math.sin(t * (9 + i * 3) + p * 1.3 + i)), 1);
          m.material.opacity = 0.55 + 0.3 * f;
        }
        for (let j = 0; j < a.smoke.length; j++) {
          const m = a.smoke[j];
          if (!m) continue;
          const prog = ((t * 0.45 + p * 0.3 + j * 1.31) % 3) / 3;
          m.position.y = spec.smokeBase + prog * 4;
          const grow = 1 + prog * 1.8;
          m.scale.set(grow * 1.4, grow * 1.4, 1);
          m.material.opacity = 0.3 * (1 - prog) * Math.min(1, prog * 6);
        }
      }
      if (a.light) a.light.intensity = spec.lightBase * f;
    } else if (slot.kind === 'pr') {
      if (effectOn) {
        if (a.v1) { a.v1.rotation.y = t * 2.3 + p; a.v1.material.opacity = 0.28 + 0.14 * f; }
        if (a.v2) { a.v2.rotation.y = -t * 1.6 + p * 2; a.v2.material.opacity = 0.2 + 0.12 * f; }
      }
      if (a.light) a.light.intensity = spec.lightBase * 0.6 * (0.8 + 0.2 * Math.sin(t * 3.1 + p));
    } else if (slot.kind === 'risk') {
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.4 + p);
      if (a.beamMat) a.beamMat.opacity = 0.16 + 0.22 * pulse;
      if (a.scan) a.scan.position.y = slot.roof + ((t * 3.2 + p) % spec.beamH);
      if (a.ring) {
        const rs = 1 + 0.3 * pulse;
        a.ring.scale.set(rs, rs, 1);
      }
      if (a.light) a.light.intensity = spec.lightBase * 0.7 * (0.5 + 0.5 * pulse);
    }
  };

  // Register with the parent's single loop, else run our own.
  useEffect(() => {
    if (!registry) return undefined;
    const fn = (t, dt, cam) => animRef.current && animRef.current(t, dt, cam);
    registry.add(fn);
    return () => registry.remove(fn);
  }, [registry]);
  useFrame((state, dt) => {
    if (registry) return;
    if (animRef.current) animRef.current(state.clock.elapsedTime, dt, state.camera);
  });

  if (!slot || !spec || !hazard || !building) return null;

  const sty = spec.sty;
  const kind = slot.kind;
  const detailed = slot.detailed;
  const atRoof = kind === 'risk';
  const baseY = atRoof ? slot.roof : 0;
  const prColor = '#ffc24b';
  const sparkColor = kind === 'pr' ? prColor : kind === 'risk' ? '#ff4040' : sty.mid;
  const glowColor = kind === 'pr' ? prColor : kind === 'risk' ? '#ff2020' : sty.glow;

  return (
    <group position={[slot.x, 0, slot.z]}>
      {/* ground / roof glow disc (all kinds, all LODs) */}
      <mesh geometry={DISC} position={[0, baseY + 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]} scale={[spec.glowR, spec.glowR, 1]}>
        <meshBasicMaterial
          ref={(m) => { refs.current.glowMat = m; }}
          map={tex.glow} color={glowColor} transparent depthWrite={false}
          blending={THREE.AdditiveBlending} opacity={0.3}
        />
      </mesh>

      {/* embers / motes — cheap and detailed both get these; distance-culled as a group */}
      <group ref={(g) => { refs.current.sparkGroup = g; }}>
        <Sparkles
          count={spec.sparkCount}
          color={sparkColor}
          size={2 + slot.severity * 0.4}
          speed={kind === 'risk' ? 0.6 : 1.4}
          opacity={0.8}
          noise={1}
          scale={[2.5, Math.max(3, spec.fh * 2.2), 2.5]}
          position={[0, baseY + Math.max(1.5, spec.fh * 1.1), 0]}
        />
      </group>

      {/* translucent danger-radius cylinder (detailed only) */}
      {detailed && (
        <mesh geometry={TUBE} position={[0, 1, 0]} scale={[slot.radius, 2, slot.radius]}>
          <meshBasicMaterial
            color={glowColor} transparent opacity={0.05} depthWrite={false}
            blending={THREE.AdditiveBlending} side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {/* kind: ISSUE — layered billboarded flame quads + smoke + light */}
      {kind === 'issue' && detailed && (
        <group ref={(g) => { refs.current.flameGroup = g; }}>
          {spec.flames.map((s, i) => (
            <mesh
              key={i}
              geometry={QUAD}
              position={[0, s.y, i * 0.02]}
              ref={(el) => { refs.current.flames[i] = el; }}
            >
              <meshBasicMaterial
                map={tex.flame} color={s.color} transparent depthWrite={false}
                blending={THREE.AdditiveBlending} opacity={0.8}
              />
            </mesh>
          ))}
          {slot.severity >= 7 && [0, 1].map((j) => (
            <mesh
              key={'s' + j}
              geometry={QUAD}
              position={[j === 0 ? -0.3 : 0.35, spec.smokeBase, -0.05]}
              ref={(el) => { refs.current.smoke[j] = el; }}
            >
              <meshBasicMaterial map={tex.smoke} color="#555555" transparent depthWrite={false} opacity={0.25} />
            </mesh>
          ))}
        </group>
      )}

      {/* kind: PR — churning amber vortex, counter-rotating open cones */}
      {kind === 'pr' && detailed && (
        <group ref={(g) => { refs.current.vortexGroup = g; }}>
          <mesh
            geometry={CONE}
            position={[0, spec.vortexH * 0.5, 0]}
            scale={[spec.vortexR, spec.vortexH, spec.vortexR]}
            ref={(el) => { refs.current.v1 = el; }}
          >
            <meshBasicMaterial
              map={tex.beam} color={prColor} transparent depthWrite={false}
              blending={THREE.AdditiveBlending} side={THREE.DoubleSide} opacity={0.35}
            />
          </mesh>
          <mesh
            geometry={CONE}
            position={[0, spec.vortexH * 0.55, 0]}
            scale={[spec.vortexR * 0.65, spec.vortexH * 1.1, spec.vortexR * 0.65]}
            ref={(el) => { refs.current.v2 = el; }}
          >
            <meshBasicMaterial
              map={tex.beam} color="#ffe08a" transparent depthWrite={false}
              blending={THREE.AdditiveBlending} side={THREE.DoubleSide} opacity={0.25}
            />
          </mesh>
        </group>
      )}

      {/* kind: RISK — pulsing red beacon column from the roof + scan pulse */}
      {kind === 'risk' && (
        <group>
          <mesh
            geometry={TUBE}
            position={[0, slot.roof + spec.beamH * 0.5, 0]}
            scale={[spec.beamR, spec.beamH, spec.beamR]}
          >
            <meshBasicMaterial
              ref={(m) => { refs.current.beamMat = m; }}
              map={tex.beam} color="#ff1e14" transparent depthWrite={false}
              blending={THREE.AdditiveBlending} side={THREE.DoubleSide} opacity={0.25}
            />
          </mesh>
          <mesh
            geometry={DISC}
            position={[0, slot.roof + 0.1, 0]}
            rotation={[-Math.PI / 2, 0, 0]}
            scale={[spec.beamR * 3.5, spec.beamR * 3.5, 1]}
            ref={(el) => { refs.current.ring = el; }}
          >
            <meshBasicMaterial
              map={tex.glow} color="#ff2020" transparent depthWrite={false}
              blending={THREE.AdditiveBlending} opacity={0.5}
            />
          </mesh>
          {detailed && (
            <mesh
              geometry={TUBE}
              position={[0, slot.roof + 0.5, 0]}
              scale={[spec.beamR * 1.5, 0.35, spec.beamR * 1.5]}
              ref={(el) => { refs.current.scan = el; }}
            >
              <meshBasicMaterial
                color="#ff6a5a" transparent depthWrite={false}
                blending={THREE.AdditiveBlending} side={THREE.DoubleSide} opacity={0.7}
              />
            </mesh>
          )}
        </group>
      )}

      {/* flickering light — detailed only (lights are the expensive part) */}
      {detailed && (
        <pointLight
          ref={(el) => { refs.current.light = el; }}
          position={[0, baseY + spec.fh * 0.7, 0]}
          color={kind === 'pr' ? prColor : kind === 'risk' ? '#ff2020' : sty.mid}
          intensity={spec.lightBase}
          distance={slot.radius * 2.2}
          decay={2}
        />
      )}

      {/* floating label above the roof (culled by distance in the parent loop) */}
      <group ref={(g) => { slot.labelRef.current = g; }} position={[0, slot.labelY, 0]}>
        <Text
          fontSize={0.5 + slot.severity * 0.05}
          color={sty.text}
          anchorX="center"
          anchorY="bottom"
          maxWidth={14}
          textAlign="center"
          outlineWidth={0.045}
          outlineColor="#000000"
        >
          {labelText(hazard)}
        </Text>
        <group ref={(g) => { slot.reasonRef.current = g; }} visible={false} position={[0, -0.25, 0]}>
          <Text
            fontSize={0.34}
            color="#ffffff"
            anchorX="center"
            anchorY="top"
            maxWidth={16}
            textAlign="center"
            lineHeight={1.25}
            outlineWidth={0.03}
            outlineColor="#000000"
          >
            {wrapReason(hazard.reason)}
          </Text>
        </group>
      </group>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Parent: places every hazard, runs the single animation/danger loop  */
/* ------------------------------------------------------------------ */

/**
 * @param {{hazards?: import('../lib/types.js').Hazard[], buildingsById?: Object}} props
 */
export default function Hazards({ hazards = [], buildingsById = {} }) {
  // Deterministic placement: severity-desc (id tiebreak), first DETAIL_CAP get
  // full detail; per-building index drives the deterministic overlap offset.
  const slots = useMemo(() => {
    const list = [];
    if (!Array.isArray(hazards)) return list;
    const perBuilding = new Map();
    const placeable = hazards
      .filter((h) => h && h.id && h.path && buildingsById && buildingsById[h.path])
      .sort((a, b) => (clampSev(b.severity) - clampSev(a.severity)) || String(a.id).localeCompare(String(b.id)));
    for (let i = 0; i < placeable.length; i++) {
      const h = placeable[i];
      const idx = perBuilding.get(h.path) || 0;
      perBuilding.set(h.path, idx + 1);
      list.push(makeSlot(h, buildingsById[h.path], idx, i < DETAIL_CAP));
    }
    return list;
  }, [hazards, buildingsById]);

  // Registry of per-marker animation callbacks — one useFrame walks them all.
  const registryList = useRef([]);
  const registry = useMemo(() => ({
    add: (fn) => { registryList.current.push(fn); },
    remove: (fn) => {
      const i = registryList.current.indexOf(fn);
      if (i >= 0) registryList.current.splice(i, 1);
    },
  }), []);

  const visited = useRef(new Set());
  const cullTimer = useRef(1); // start >interval so the first frame culls
  useEffect(() => { visited.current.clear(); }, [hazards]);

  // Detailed-only slot list + a reusable "already picked" scratch flag array
  // for the nearest-N light selection below — both sized once per `slots`
  // identity change, never inside the frame loop.
  const detailedSlots = useMemo(() => slots.filter((s) => s.detailed), [slots]);
  const lightPicked = useMemo(() => new Uint8Array(detailedSlots.length), [detailedSlots]);

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime;
    const cam = state.camera;

    // --- distance LOD (every frame, zero allocation): compute distSq once
    // per slot and derive danger + effect/spark visibility from it, THEN run
    // the per-marker callbacks so they react the same frame, not one late. ---
    const px = playerState.x;
    const pz = playerState.z;
    let best = 0;
    let bestId = null;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      const dx = px - s.x;
      const dz = pz - s.z;
      const d2 = dx * dx + dz * dz;
      s.distSq = d2;
      s.effectOn = d2 < EFFECT_CULL_DIST_SQ;
      s.sparkOn = d2 < SPARK_CULL_DIST_SQ;
      if (d2 < s.radius * s.radius) {
        if (!visited.current.has(s.id)) {
          visited.current.add(s.id);
          playerState.hazardsVisited += 1;
        }
        const depth = 1 - Math.sqrt(d2) / s.radius; // 0 at edge, 1 at center
        const eff = depth * (0.3 + s.severity * 0.07); // severity 10 => full strength
        if (eff > best) { best = eff; bestId = s.id; }
      }
    }
    playerState.activeHazard = bestId;
    const target = Math.min(1, best);
    const k = 1 - Math.exp(-dt * 4); // frame-rate independent smoothing
    playerState.dangerLevel += (target - playerState.dangerLevel) * k;
    if (target === 0 && playerState.dangerLevel < 0.002) playerState.dangerLevel = 0;

    // --- cap concurrent real-time point lights to the nearest N detailed
    // hazards. Forward-lit MeshLambertMaterial pays a per-fragment cost for
    // EVERY active light across the whole visible scene, so this is the
    // single biggest lever for keeping frame time flat as hazard count grows. ---
    const dn = detailedSlots.length;
    if (dn <= NEAR_LIGHT_CAP) {
      for (let i = 0; i < dn; i++) detailedSlots[i].lightOn = true;
    } else {
      lightPicked.fill(0);
      for (let i = 0; i < dn; i++) detailedSlots[i].lightOn = false;
      for (let k2 = 0; k2 < NEAR_LIGHT_CAP; k2++) {
        let bestI = -1;
        let bestD = Infinity;
        for (let i = 0; i < dn; i++) {
          if (lightPicked[i]) continue;
          const d = detailedSlots[i].distSq;
          if (d < bestD) { bestD = d; bestI = i; }
        }
        if (bestI < 0) break;
        lightPicked[bestI] = 1;
        detailedSlots[bestI].lightOn = true;
      }
    }

    const fns = registryList.current;
    for (let i = 0; i < fns.length; i++) fns[i](t, dt, cam);

    // --- throttled label culling + nearest-hazard reason text (reuses distSq) ---
    cullTimer.current += dt;
    if (cullTimer.current >= CULL_INTERVAL) {
      cullTimer.current = 0;
      let nearest = null;
      let nearestD2 = Infinity;
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        const d2 = s.distSq;
        if (s.labelRef.current) {
          s.labelRef.current.visible = d2 < LABEL_CULL_DIST * LABEL_CULL_DIST;
        }
        if (d2 < s.radius * s.radius && d2 < nearestD2) {
          nearestD2 = d2;
          nearest = s;
        }
      }
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        if (s.reasonRef.current) s.reasonRef.current.visible = s === nearest;
      }
    }
  });

  return (
    <group>
      {slots.map((s) => (
        <HazardMarker key={s.id} hazard={s.hazard} building={s.building} slot={s} registry={registry} />
      ))}
    </group>
  );
}
