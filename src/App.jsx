import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Scene from './Scene.jsx';
import HUD from './components/HUD.jsx';
import ReviewPanel from './components/ReviewPanel.jsx';
import { loadWorld } from './lib/pipeline.js';
import { makeCodeFetcher } from './lib/github.js';
import { isMockRepo } from './lib/mockData.js';
import { playerState, resetPlayerState } from './lib/playerState.js';
import { createChase } from './lib/chase.js';
import {
  generateQuests,
  createQuestState,
  generateNpcs,
  updateQuestProgress,
  questSummary,
} from './lib/quests.js';

/** Keeps a WebGL/component failure from taking down the whole page mid-demo. */
class SceneBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: null };
  }

  static getDerivedStateFromError(error) {
    return { failed: error };
  }

  componentDidCatch(error) {
    console.error('[repo-world] scene error:', error);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="rw-scene-error">
          <p>The 3D scene hit an error.</p>
          <pre>{String(this.state.failed?.message || this.state.failed)}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const [phase, setPhase] = useState('idle');
  const [progress, setProgress] = useState({ stage: '', detail: '' });
  const [world, setWorld] = useState(null);
  const [error, setError] = useState(null);
  const fetchCodeRef = useRef(null);
  const abortRef = useRef(null);

  // ---- Game state -------------------------------------------------------------
  const [chase, setChase] = useState(null);
  const [npcs, setNpcs] = useState([]);
  const [reviewHazard, setReviewHazard] = useState(null);
  const questRef = useRef(null);
  // Quest progress is mutated in place by updateQuestProgress; this counter forces the
  // re-render so the HUD tracker actually updates.
  const [questTick, setQuestTick] = useState(0);

  const recordEvent = useCallback((event) => {
    if (!questRef.current) return;
    updateQuestProgress(questRef.current, event);
    setQuestTick((t) => t + 1);
  }, []);

  /** A bug died — Greptile "opened a PR". Open the review panel and credit the quest. */
  const handleKill = useCallback(
    (event) => {
      const hazard = world?.hazards?.find((h) => h.id === event.bugId) || null;
      if (hazard) setReviewHazard(hazard);
      recordEvent({ type: 'bugKilled', bugId: event.bugId, severity: event.severity });
    },
    [world, recordEvent]
  );

  const handleTalk = useCallback(
    (npcId) => recordEvent({ type: 'talk', npcId }),
    [recordEvent]
  );

  // Credit "visit this file / district" objectives as the player walks the city.
  useEffect(() => {
    if (phase !== 'ready') return undefined;
    const seen = new Set();
    const id = setInterval(() => {
      const path = playerState.focusedBuilding;
      if (!path || seen.has(path)) return;
      seen.add(path);
      recordEvent({ type: 'visit', path });
      const district = String(path).includes('/') ? String(path).split('/')[0] : '/';
      recordEvent({ type: 'district', name: district });
    }, 500);
    return () => clearInterval(id);
  }, [phase, recordEvent]);

  // The HUD reads quest progress off the world object.
  const worldForHud = useMemo(() => {
    if (!world) return null;
    if (!questRef.current) return world;
    return { ...world, questSummary: questSummary(questRef.current) };
    // questTick is the invalidation signal for the in-place quest mutations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, questTick]);

  const handleSubmit = useCallback(async (input) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPhase('loading');
    setError(null);
    setWorld(null);
    setProgress({ stage: 'Starting up', detail: '' });

    try {
      let firstWorld = true;
      await loadWorld(input, {
        signal: controller.signal,
        onProgress: (stage, detail = '') => {
          if (!controller.signal.aborted) setProgress({ stage, detail });
        },
        onWorld: (nextWorld) => {
          if (controller.signal.aborted || !nextWorld) return;
          if (firstWorld) {
            firstWorld = false;
            resetPlayerState(nextWorld.spawn);
            fetchCodeRef.current = isMockRepo(input)
              ? async () => ''
              : makeCodeFetcher(nextWorld.repo);

            // Spin up the game: bugs + Greptile, then quests and the NPCs who give them.
            try {
              setChase(createChase(nextWorld.hazards, nextWorld.layout.buildings));
            } catch (err) {
              console.error('[repo-world] chase init failed:', err);
              setChase(null);
            }
            try {
              const quests = generateQuests(nextWorld);
              questRef.current = createQuestState(quests);
              setNpcs(generateNpcs(nextWorld, quests) || []);
              setQuestTick((t) => t + 1);
            } catch (err) {
              console.error('[repo-world] quest init failed:', err);
              questRef.current = null;
              setNpcs([]);
            }

            setPhase('ready');
          }
          setWorld(nextWorld);
        },
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      console.error('[repo-world] load failed:', err);
      setError(err?.message || String(err));
      setPhase('error');
    }
  }, []);

  const handleReset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    fetchCodeRef.current = null;
    setWorld(null);
    setError(null);
    setProgress({ stage: '', detail: '' });
    setPhase('idle');
  }, []);

  return (
    <div className="rw-root">
      {phase === 'ready' && world ? (
        <SceneBoundary key={`${world.repo.owner}/${world.repo.repo}`}>
          <Scene
            world={world}
            fetchCode={fetchCodeRef.current}
            chase={chase}
            npcs={npcs}
            questState={questRef.current}
            onKill={handleKill}
            onTalk={handleTalk}
          />
        </SceneBoundary>
      ) : null}
      <HUD
        phase={phase}
        progress={progress}
        world={worldForHud}
        error={error}
        chase={chase}
        onSubmit={handleSubmit}
        onReset={handleReset}
      />
      {phase === 'ready' && reviewHazard ? (
        <ReviewPanel
          repo={world?.repo || null}
          hazard={reviewHazard}
          onClose={() => setReviewHazard(null)}
          onApprove={() => recordEvent({ type: 'approve', hazardId: reviewHazard.id })}
        />
      ) : null}
    </div>
  );
}
