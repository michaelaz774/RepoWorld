/**
 * Minimap — 2D top-down canvas map of the city.
 *
 * Plain <canvas> + 2D context (no three.js). Redraws on a rAF loop so the
 * player arrow tracks playerState without any React re-renders.
 * Styled to match the blocky/voxel world: flat fills, hard edges, no glow.
 */
import { useEffect, useRef } from 'react';
import { playerState } from '../lib/playerState.js';
import { activeQuests } from '../lib/quests.js';

const HAZARD_COLORS = { issue: '#d43b2e', pr: '#9b5fc0', risk: '#e0a52a' };
const BUG_COLOR = '#d43b2e';       // red — same red as HAZARD_COLORS.issue / --rw-red
const GREPTILE_COLOR = '#3ec95a';  // green — matches the in-world Greptile beacon color
const WIZARD_HUES = ['#ff3b3b', '#ff9d2e', '#ffe14d', '#3ec95a', '#39b7ff', '#8b5cf6'];
const NPC_NEW_COLOR = '#ffd23f';   // gold — matches NPCs.jsx's "!" marker/beacon
const NPC_OTHER_COLOR = '#8fd3ff'; // blue — matches NPCs.jsx's "?" marker/beacon (and the
                                    // dim "nothing new" beacon closely enough at this scale)

/**
 * Pull a live bug array out of `chase`. Shape/liveness is owned by another
 * agent's chase simulation — read defensively, same posture as Targeting.jsx.
 */
function extractBugs(chase) {
  if (!chase) return null;
  if (Array.isArray(chase.bugs)) return chase.bugs;
  return null;
}

/**
 * Pull the live Greptile list out of `chase`. Accepts either the new pack
 * shape (`chase.greptiles`, an array) or the older single-creature shape
 * (`chase.greptile`, one object) so this keeps working across either.
 */
function extractGreptiles(chase) {
  if (!chase) return null;
  if (Array.isArray(chase.greptiles)) return chase.greptiles;
  if (chase.greptile && typeof chase.greptile === 'object') return [chase.greptile];
  return null;
}

export default function Minimap({ layout, hazards = [], chase = null, npcs = [], questState = null, size = 190 }) {
  const canvasRef = useRef(null);
  const layoutRef = useRef(layout);
  const hazardsRef = useRef(hazards);
  const chaseRef = useRef(chase);
  const npcsRef = useRef(npcs);
  const questStateRef = useRef(questState);
  const byIdCache = useRef({ layout: null, map: new Map() });
  layoutRef.current = layout;
  hazardsRef.current = hazards;
  chaseRef.current = chase;
  npcsRef.current = npcs;
  questStateRef.current = questState;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    let raf = 0;

    function draw(now) {
      raf = requestAnimationFrame(draw);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, size, size);

      // Panel background — flat stone slab, no transparency blur.
      ctx.fillStyle = '#8f8a80';
      ctx.fillRect(0, 0, size, size);

      const lay = layoutRef.current;
      const buildings = (lay && Array.isArray(lay.buildings)) ? lay.buildings : [];
      const districts = (lay && Array.isArray(lay.districts)) ? lay.districts : [];
      const bounds = lay && lay.bounds ? lay.bounds : null;

      // World -> canvas transform, fit bounds with padding, preserve aspect.
      const pad = 12;
      let minX = -20, maxX = 20, minZ = -20, maxZ = 20;
      if (bounds && isFinite(bounds.minX) && bounds.maxX > bounds.minX) {
        ({ minX, maxX, minZ, maxZ } = bounds);
      }
      const spanX = Math.max(maxX - minX, 1);
      const spanZ = Math.max(maxZ - minZ, 1);
      const scale = Math.min((size - pad * 2) / spanX, (size - pad * 2) / spanZ);
      const offX = (size - spanX * scale) / 2;
      const offZ = (size - spanZ * scale) / 2;
      const wx = (x) => offX + (x - minX) * scale;
      const wz = (z) => offZ + (z - minZ) * scale;

      // Districts as flat grass plazas with a hard outline.
      for (const dis of districts) {
        if (!dis) continue;
        ctx.fillStyle = 'rgba(106, 168, 52, 0.28)';
        ctx.strokeStyle = 'rgba(44, 38, 30, 0.55)';
        ctx.lineWidth = 1;
        const x = Math.round(wx(dis.x - dis.w / 2));
        const z = Math.round(wz(dis.z - dis.d / 2));
        ctx.fillRect(x, z, Math.round(dis.w * scale), Math.round(dis.d * scale));
        ctx.strokeRect(x + 0.5, z + 0.5, Math.round(dis.w * scale), Math.round(dis.d * scale));
      }

      // Buildings tinted by language color — flat, no alpha gradient.
      for (const b of buildings) {
        if (!b) continue;
        const bw = Math.max(Math.round((b.w || 2) * scale), 2);
        const bd = Math.max(Math.round((b.d || 2) * scale), 2);
        ctx.fillStyle = b.color || '#8b949e';
        ctx.fillRect(Math.round(wx(b.x) - bw / 2), Math.round(wz(b.z) - bd / 2), bw, bd);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(wx(b.x) - bw / 2) + 0.5, Math.round(wz(b.z) - bd / 2) + 0.5, bw, bd);
      }

      // Hazards as flat pixel-square blips (no blur/glow) at their building's position.
      const hz = hazardsRef.current || [];
      if (hz.length && buildings.length) {
        if (byIdCache.current.layout !== lay) {
          const m = new Map();
          for (const b of buildings) if (b) m.set(b.id, b);
          byIdCache.current = { layout: lay, map: m };
        }
        const byId = byIdCache.current.map;
        const pulse = 0.5 + 0.5 * Math.sin(now / 300);
        for (const h of hz) {
          if (!h || !h.path) continue;
          const b = byId.get(h.path);
          if (!b) continue;
          const r = Math.round(3 + (h.severity || 1) * 0.3 + pulse * 1.5);
          const px = Math.round(wx(b.x));
          const pz = Math.round(wz(b.z));
          ctx.fillStyle = HAZARD_COLORS[h.kind] || HAZARD_COLORS.issue;
          ctx.globalAlpha = 0.55 + pulse * 0.35;
          ctx.fillRect(px - r, pz - r, r * 2, r * 2);
          ctx.globalAlpha = 1;
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
          ctx.lineWidth = 1;
          ctx.strokeRect(px - r + 0.5, pz - r + 0.5, r * 2, r * 2);
        }
      }

      // Live bugs (red) and Greptiles (green) — the actual roaming creatures,
      // drawn at their own x/z from the chase sim rather than their building's
      // position, so the map tracks the chase as it happens. Flat squares,
      // hard dark outlines, integer-rounded coords — same pixel-crisp style
      // as everything else on this map.
      const chaseNow = chaseRef.current;
      const targetedBug = playerState.targetedBug;

      const bugs = extractBugs(chaseNow);
      if (bugs) {
        for (const bug of bugs) {
          if (!bug || bug.state !== 'alive') continue;
          if (!Number.isFinite(bug.x) || !Number.isFinite(bug.z)) continue;
          const px = Math.round(wx(bug.x));
          const pz = Math.round(wz(bug.z));
          const isTargeted = targetedBug != null && bug.id === targetedBug;
          const r = isTargeted ? 4 : 2.5;
          ctx.fillStyle = BUG_COLOR;
          ctx.fillRect(px - r, pz - r, r * 2, r * 2);
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
          ctx.lineWidth = 1;
          ctx.strokeRect(px - r + 0.5, pz - r + 0.5, r * 2, r * 2);
          if (isTargeted) {
            // Pulsing ring so the player can line up a deploy from the map.
            const pulse = 0.5 + 0.5 * Math.sin(now / 250);
            const ringR = r + 2 + pulse * 2;
            ctx.strokeStyle = BUG_COLOR;
            ctx.lineWidth = 1;
            ctx.strokeRect(
              Math.round(px - ringR) + 0.5,
              Math.round(pz - ringR) + 0.5,
              Math.round(ringR * 2),
              Math.round(ringR * 2)
            );
          }
        }
      }

      const greptiles = extractGreptiles(chaseNow);
      if (greptiles) {
        for (const g of greptiles) {
          if (!g || !Number.isFinite(g.x) || !Number.isFinite(g.z)) continue;
          const px = Math.round(wx(g.x));
          const pz = Math.round(wz(g.z));
          const r = 3;
          ctx.fillStyle = GREPTILE_COLOR;
          ctx.fillRect(px - r, pz - r, r * 2, r * 2);
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
          ctx.lineWidth = 1;
          ctx.strokeRect(px - r + 0.5, pz - r + 0.5, r * 2, r * 2);
        }
      }

      // NPCs (gold = fresh quest, blue = in-progress/nothing new) — a third,
      // distinct color family from bugs (red) and Greptiles (green), matching
      // NPCs.jsx's beacon/marker colors so the map and the world agree.
      const npcList = Array.isArray(npcsRef.current) ? npcsRef.current : [];
      if (npcList.length) {
        const progressById = new Map();
        for (const q of activeQuests(questStateRef.current)) progressById.set(q.id, q.progress);
        for (const npc of npcList) {
          if (!npc || !Number.isFinite(npc.x) || !Number.isFinite(npc.z)) continue;
          const p = npc.questId ? progressById.get(npc.questId) : null;
          const isNew = !!(p && !(p.current > 0));
          const px = Math.round(wx(npc.x));
          const pz = Math.round(wz(npc.z));
          const r = 3;
          ctx.fillStyle = isNew ? NPC_NEW_COLOR : NPC_OTHER_COLOR;
          ctx.fillRect(px - r, pz - r, r * 2, r * 2);
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
          ctx.lineWidth = 1;
          ctx.strokeRect(px - r + 0.5, pz - r + 0.5, r * 2, r * 2);
        }
      }

      // The wizard — a cycling rainbow pip, matching his sky beam. Drawn last of
      // the world markers and a size larger than the NPC squares, because
      // "where is he?" is the single most common reason to look at this map.
      if (Number.isFinite(playerState.wizardX) && Number.isFinite(playerState.wizardZ)) {
        const px = Math.round(wx(playerState.wizardX));
        const pz = Math.round(wz(playerState.wizardZ));
        const hue = WIZARD_HUES[Math.floor((now || 0) / 220) % WIZARD_HUES.length];
        const r = 4;
        ctx.fillStyle = hue;
        ctx.fillRect(px - r, pz - r, r * 2, r * 2);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.lineWidth = 1;
        ctx.strokeRect(px - r + 0.5, pz - r + 0.5, r * 2, r * 2);
        // A white pip in the middle so it reads as "special", not just another NPC.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(px - 1, pz - 1, 2, 2);
      }

      // Player arrow (yaw 0 = looking down -Z = up on the map) — flat triangle, dark outline.
      ctx.save();
      ctx.translate(wx(playerState.x), wz(playerState.z));
      ctx.rotate(-playerState.yaw);
      ctx.beginPath();
      ctx.moveTo(0, -6);
      ctx.lineTo(4.5, 5);
      ctx.lineTo(0, 2.5);
      ctx.lineTo(-4.5, 5);
      ctx.closePath();
      ctx.fillStyle = '#e8f5c9';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#2c261e';
      ctx.stroke();
      ctx.restore();

      // Chunky stone frame.
      ctx.strokeStyle = '#2c261e';
      ctx.lineWidth = 3;
      ctx.strokeRect(1.5, 1.5, size - 3, size - 3);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(3, 3, size - 6, size - 6);
    }

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      className="rw-minimap"
      style={{ width: size, height: size, imageRendering: 'pixelated' }}
      aria-label="Minimap"
    />
  );
}
