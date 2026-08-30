import { Suspense, useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { AdaptiveDpr, Preload } from '@react-three/drei';
import * as THREE from 'three';

import SkyEnvironment from './components/SkyEnvironment.jsx';
import Ground from './components/Ground.jsx';
import Roads from './components/Roads.jsx';
import Nature from './components/Nature.jsx';
import StreetProps from './components/StreetProps.jsx';
import Buildings from './components/Buildings.jsx';
import DependencyLines from './components/DependencyLines.jsx';
import Hazards from './components/Hazards.jsx';
import Pedestrians from './components/Pedestrians.jsx';
import NPCs from './components/NPCs.jsx';
import Bugs from './components/Bugs.jsx';
import Greptile from './components/Greptile.jsx';
import Targeting from './components/Targeting.jsx';
import Player from './components/Player.jsx';
import Cars from './components/Cars.jsx';
import Wizard from './components/Wizard.jsx';
import { EYE_HEIGHT } from './lib/types.js';
import { playerState } from './lib/playerState.js';
import { pickWizardHome } from './lib/wizard.js';
import { assignTarget, stepChase, drainEvents } from './lib/chase.js';

/**
 * The 3D world. Everything here is driven by the WorldData object from the pipeline,
 * which arrives progressively — edges, richer hazards, and the generated sky can all
 * show up seconds or minutes after the city is already walkable.
 */
/**
 * Drives the bug/Greptile simulation from inside the render loop. This is the seam between
 * the player's input and the chase: it consumes the one-frame `deployRequested` flag that
 * Targeting sets, sends Greptile after the bug under the crosshair, advances the sim, and
 * forwards kill events up so the review panel can open on the exact frame a bug dies.
 */
function ChaseDriver({ chase, onKill }) {
  // Exposed for debugging/automated testing of the deploy loop from the console.
  useEffect(() => {
    if (typeof window !== 'undefined') window.__chase = chase;
  }, [chase]);

  useFrame((_, dt) => {
    if (!chase) return;

    if (playerState.deployRequested) {
      playerState.deployRequested = false;
      if (playerState.targetedBug) assignTarget(chase, playerState.targetedBug);
    }

    stepChase(chase, dt);

    const events = drainEvents(chase);
    for (let i = 0; i < events.length; i++) {
      if (events[i].type === 'kill' && onKill) onKill(events[i]);
    }
  });
  return null;
}

export default function Scene({
  world,
  fetchCode,
  chase = null,
  npcs = [],
  questState = null,
  onKill = null,
  onTalk = null,
  wizardControlRef = null,
  wizardChatOpen = false,
  wizardStatus = null,
}) {
  const buildings = world?.layout?.buildings || [];
  const hazards = world?.hazards || [];
  const edges = world?.edges || [];

  const buildingsById = useMemo(() => {
    const map = {};
    for (const b of buildings) map[b.id] = b;
    return map;
  }, [buildings]);

  // Drives sky tint + fog: how dangerous this repo looks overall.
  const hazardIntensity = useMemo(() => {
    if (!hazards.length) return 0;
    const total = hazards.reduce((sum, h) => sum + (h.severity || 0), 0);
    return Math.min(1, total / (buildings.length * 1.2 + 40));
  }, [hazards, buildings.length]);

  const spawn = world?.spawn || { x: 0, y: EYE_HEIGHT, z: 40 };

  // The wizard waits a short walk from where you land — close enough to find by
  // his violet beacon, and on clear ground rather than inside a facade.
  const wizardHome = useMemo(
    () => pickWizardHome(world?.layout, spawn),
    [world?.layout, spawn.x, spawn.z]
  );
  const createdRef = useRef(false);

  // R3F v9 only creates its WebGL root once react-use-measure reports a non-zero container
  // size, which it normally learns from a ResizeObserver on the Canvas's own inner div. On this
  // mount path (Canvas appearing into an already-laid-out page, rather than being present at
  // initial paint) that observer's very first notification can be silently dropped by the
  // browser (a disconnect-then-re-observe on the same element right after mount starves the
  // callback), and since the size never changes again afterwards, it then never fires again —
  // onCreated never runs and the canvas is stuck at its intrinsic 300x150. react-use-measure also
  // keeps a plain `window.resize` listener wired up as a fallback measurement path, so nudging it
  // once after mount reliably unblocks initialization without touching the ResizeObserver-driven
  // resize handling that keeps the canvas responsive afterwards.
  // A SINGLE nudge is not enough: it can fire before the canvas is mounted and measured,
  // in which case the observer is still starved and the canvas stays blank forever. So keep
  // nudging every frame until onCreated actually fires (createdRef), then stop. Costs nothing
  // after init, and is bounded so a genuine WebGL failure can't spin forever.
  // Deliberately a timer, NOT requestAnimationFrame: rAF is paused in background/hidden tabs,
  // so an rAF-based retry silently never runs and the canvas stays blank until the tab is
  // focused. setInterval still fires (throttled) when hidden, so the world is ready the moment
  // the user looks at it. Stops as soon as onCreated fires; bounded so a real WebGL failure
  // can't spin forever.
  useEffect(() => {
    if (createdRef.current) return undefined;
    let ticks = 0;
    const id = setInterval(() => {
      ticks += 1;
      if (createdRef.current || ticks > 80) {
        clearInterval(id);
        return;
      }
      window.dispatchEvent(new Event('resize'));
    }, 125);
    window.dispatchEvent(new Event('resize'));
    return () => clearInterval(id);
  }, []);

  return (
    <Canvas
      shadows="soft"
      dpr={[1, 1.75]}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      camera={{ fov: 72, near: 0.1, far: 2000, position: [spawn.x, spawn.y, spawn.z] }}
      onCreated={(state) => {
        createdRef.current = true;
        state.gl.toneMapping = THREE.ACESFilmicToneMapping;
        state.gl.toneMappingExposure = 1.05;
        state.scene.background = new THREE.Color('#070a12');
        if (typeof window !== 'undefined') window.__r3f = state;
      }}
    >
      <Suspense fallback={null}>
        <SkyEnvironment url={world?.skyboxUrl || null} hazardIntensity={hazardIntensity} />
        <Ground layout={world?.layout} />
        <Roads layout={world?.layout} />
        <Nature layout={world?.layout} />
        <StreetProps layout={world?.layout} />
        <Buildings buildings={buildings} fetchCode={fetchCode} />
        <DependencyLines edges={edges} buildingsById={buildingsById} />
        <Hazards hazards={hazards} buildingsById={buildingsById} />
        <Pedestrians layout={world?.layout} />
        <NPCs npcs={npcs} questState={questState} onTalk={onTalk} />
        <Bugs chase={chase} />
        <Greptile chase={chase} buildingsById={buildingsById} />
        <Preload all />
      </Suspense>
      <ChaseDriver chase={chase} onKill={onKill} />
      <Targeting chase={chase} />
      <Player buildings={buildings} spawn={spawn} />
      {/* MUST stay after <Player>: same-priority useFrame callbacks run in mount
          order, and the chase camera has to write camera.position last to win. */}
      <Cars layout={world?.layout || null} spawn={spawn} />
      <Wizard
        home={wizardHome}
        buildings={buildings}
        paths={world?.layout?.paths || null}
        chase={chase}
        controlRef={wizardControlRef}
        chatOpen={wizardChatOpen}
        status={wizardStatus}
      />
      <AdaptiveDpr pixelated />
    </Canvas>
  );
}
