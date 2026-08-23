import { useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { QuadraticBezierLine } from '@react-three/drei';
import * as THREE from 'three';
import { playerState } from '../lib/playerState.js';

/**
 * DependencyLines — imports rendered as faint, low-arcing threads between building
 * rooftops. Deliberately understated: this is a "notice it if you look" detail in a
 * bright blocky world, not a sci-fi data-flow overlay. Two things keep it that way:
 *
 * - Style: a muted warm amber (in the same cheerful-daylight family as the rest of the
 *   world, nothing neon/cyan), low opacity, thin lines, and a shallow arc that hugs the
 *   rooftops instead of towering above the skyline. `toneMapped` is left at its default
 *   (true) so these get compressed by the same ACES curve as everything else instead of
 *   popping out as an unlit-looking overlay.
 * - Visibility: every edge is precomputed once (cheap), but only a small, nearest-to-
 *   the-player subset is ever *mounted* as a live QuadraticBezierLine — recomputed on a
 *   throttle, not every frame. A city can have hundreds of edges; only a handful are
 *   ever drawn at once.
 *
 * @param {{edges?: import('../lib/types.js').DepEdge[],
 *          buildingsById?: Record<string, import('../lib/types.js').Building>}} props
 */

const DIM = new THREE.Color('#7a5a2e'); // muted bronze/amber — reads as "dim thread"
const BRIGHT = new THREE.Color('#e8b84b'); // warm honey/gold — reads as "active thread"
const scratch = new THREE.Color();

const MAX_VISIBLE = 16; // hard cap on simultaneously-mounted lines
const CULL_RADIUS = 60; // only consider edges whose midpoint is within this of the player
const CULL_RADIUS_SQ = CULL_RADIUS * CULL_RADIUS;
const RESELECT_INTERVAL = 0.4; // seconds between throttled visibility re-picks

export default function DependencyLines({ edges = [], buildingsById = {} }) {
  // Refs to the underlying Line2 objects, indexed to match the currently-mounted subset.
  const lineRefs = useRef([]);

  // Precompute every edge's static geometry/style once; nothing below allocates per frame.
  const lines = useMemo(() => {
    const out = [];
    if (!Array.isArray(edges) || !buildingsById) return out;
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      if (!e) continue;
      const a = buildingsById[e.from];
      const b = buildingsById[e.to];
      if (!a || !b) continue; // defensive: skip edges with missing endpoints

      const ax = a.x || 0, az = a.z || 0, ah = Math.max(a.height || 1, 0.5);
      const bx = b.x || 0, bz = b.z || 0, bh = Math.max(b.height || 1, 0.5);
      const start = [ax, ah + 0.15, az];
      const end = [bx, bh + 0.15, bz];
      const dist = Math.hypot(bx - ax, bz - az);
      // Shallow arc that hugs the rooftops — capped so long edges don't tower over the
      // skyline the way an unbounded distance-scaled apex would.
      const apexLift = Math.min(2.2, 0.4 + dist * 0.05);
      const mid = [(ax + bx) / 2, Math.max(ah, bh) + apexLift, (az + bz) / 2];
      const midX = (ax + bx) / 2;
      const midZ = (az + bz) / 2;

      const w = Math.max(1, Math.min(5, e.weight || 1));
      const t = (w - 1) / 4; // 0..1
      const color = '#' + scratch.copy(DIM).lerp(BRIGHT, t).getHexString();
      // Deterministic per-edge jitter so the flow doesn't look mechanical.
      const jitter = ((i * 2654435761) >>> 0) % 1000 / 1000;
      out.push({
        key: `${e.from}->${e.to}`,
        start,
        end,
        mid,
        midX,
        midZ,
        color,
        lineWidth: 0.6 + t * 0.6,
        opacity: 0.14 + t * 0.16,
        speed: 1.6 + jitter * 1.8,
      });
    }
    return out;
  }, [edges, buildingsById]);

  // Throttled nearest-to-player subset — recomputed a few times a second, not every frame.
  const [visible, setVisible] = useState([]);
  const accRef = useRef(1e9);
  const keyRef = useRef('');

  useFrame((_, delta) => {
    // Animate the currently-mounted dashes every frame (cheap, no allocation).
    const refs = lineRefs.current;
    const d = Math.min(delta, 0.1); // clamp tab-switch spikes
    for (let i = 0; i < visible.length; i++) {
      const obj = refs[i];
      if (!obj || !obj.material) continue;
      obj.material.dashOffset -= visible[i].speed * d;
    }

    // Throttled: re-pick which edges are near enough to the player to bother drawing.
    accRef.current += delta;
    if (accRef.current < RESELECT_INTERVAL || lines.length === 0) return;
    accRef.current = 0;

    const px = playerState.x;
    const pz = playerState.z;
    const candidates = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const dx = l.midX - px;
      const dz = l.midZ - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 < CULL_RADIUS_SQ) candidates.push([d2, l]);
    }
    candidates.sort((x, y) => x[0] - y[0]);
    const chosen = candidates.slice(0, MAX_VISIBLE).map(([, l]) => l);
    const key = chosen.map((l) => l.key).join('|');
    if (key !== keyRef.current) {
      keyRef.current = key;
      lineRefs.current = [];
      setVisible(chosen);
    }
  });

  if (lines.length === 0) return null;

  return (
    <group>
      {visible.map((l, i) => (
        <QuadraticBezierLine
          key={l.key}
          ref={(el) => { lineRefs.current[i] = el; }}
          start={l.start}
          end={l.end}
          mid={l.mid}
          segments={12}
          color={l.color}
          lineWidth={l.lineWidth}
          dashed
          dashSize={0.8}
          gapSize={0.5}
          transparent
          opacity={l.opacity}
          depthWrite={false}
        />
      ))}
    </group>
  );
}
