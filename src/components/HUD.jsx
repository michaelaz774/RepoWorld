/**
 * HUD — everything the user sees outside the 3D canvas.
 *
 * Phases:
 *   idle    -> landing screen (repo input, example chips)
 *   loading -> staged pipeline progress
 *   ready   -> in-world overlay (pointer-events: none root; auto only on buttons)
 *   error   -> failure screen with retry
 */
import { useEffect, useRef, useState } from 'react';
import { playerState } from '../lib/playerState.js';
import Minimap from './Minimap.jsx';

const EXAMPLES = [
  { label: 'facebook/react', value: 'facebook/react' },
  { label: 'vercel/next.js', value: 'vercel/next.js' },
  { label: 'tailwindlabs/tailwindcss', value: 'tailwindlabs/tailwindcss' },
  { label: 'demo (offline)', value: 'demo' },
];

const FLAVOR_LINES = [
  'indexing repository',
  'asking Greptile what’s dangerous',
  'zoning the districts',
  'stacking the blocks',
  'wiring up the import power grid',
  'setting the risky files on fire',
  'painting the pixel textures',
  'polishing the skyline',
];

const HAZARD_DOTS = [
  { kind: 'issue', label: 'issues', className: 'rw-dot-issue' },
  { kind: 'pr', label: 'PRs', className: 'rw-dot-pr' },
  { kind: 'risk', label: 'risks', className: 'rw-dot-risk' },
];

function formatBytes(n) {
  if (!n || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function HUD({
  phase,
  progress,
  world,
  error,
  chase = null,
  npcs = [],
  questState = null,
  onSubmit,
  onReset,
}) {
  if (phase === 'loading') return <LoadingScreen progress={progress} />;
  if (phase === 'ready') {
    return <WorldHUD world={world} chase={chase} npcs={npcs} questState={questState} onReset={onReset} />;
  }
  if (phase === 'error') return <ErrorScreen error={error} onReset={onReset} />;
  return <LandingScreen onSubmit={onSubmit} />;
}

/* ---------------------------------------------------------------- idle */

function LandingScreen({ onSubmit }) {
  const [value, setValue] = useState('');

  function submit(v) {
    const input = String(v ?? value).trim();
    if (input && typeof onSubmit === 'function') onSubmit(input);
  }

  return (
    <div className="rw-screen rw-landing">
      <div className="rw-bg-sky" aria-hidden="true" />
      <div className="rw-bg-clouds" aria-hidden="true">
        <span /><span /><span />
      </div>
      <div className="rw-bg-ground" aria-hidden="true" />
      <div className="rw-landing-inner">
        <div className="rw-kicker">a blocky adventure through your codebase</div>
        <h1 className="rw-title">
          REPO<span className="rw-title-accent">WORLD</span>
        </h1>
        <p className="rw-tagline">
          Explore your code like a world. Hunt the bugs. Watch Greptile fix them.
        </p>

        <form
          className="rw-input-row"
          onSubmit={(e) => { e.preventDefault(); submit(); }}
        >
          <input
            className="rw-input"
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="github.com/owner/repo or owner/repo"
            autoFocus
            spellCheck={false}
            autoComplete="off"
            aria-label="Repository URL"
          />
          <button className="rw-btn rw-btn-primary" type="submit">
            ENTER WORLD
          </button>
        </form>

        <div className="rw-chips">
          <span className="rw-chips-label">try:</span>
          {EXAMPLES.map((ex) => (
            <button
              key={ex.value}
              type="button"
              className="rw-chip"
              onClick={() => { setValue(ex.value); submit(ex.value); }}
            >
              {ex.label}
            </button>
          ))}
        </div>

        <p className="rw-controls-hint">
          <kbd>WASD</kbd> move &nbsp;·&nbsp; <kbd>Shift</kbd> sprint &nbsp;·&nbsp;{' '}
          <kbd>F</kbd> fly &nbsp;·&nbsp; mouse to look &nbsp;·&nbsp; walk into the fire to inspect it
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- loading */

function LoadingScreen({ progress }) {
  const [flavorIdx, setFlavorIdx] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFlavorIdx((i) => i + 1), 2200);
    return () => clearInterval(id);
  }, []);

  const stage = (progress && progress.stage) || 'warming up';
  const detail = progress && progress.detail;
  const pct = progress && typeof progress.pct === 'number'
    ? Math.max(0, Math.min(100, progress.pct))
    : null;

  return (
    <div className="rw-screen rw-loading">
      <div className="rw-bg-sky" aria-hidden="true" />
      <div className="rw-bg-ground" aria-hidden="true" />
      <div className="rw-loading-inner rw-panel">
        <div className="rw-loading-mark" aria-hidden="true">
          <span /><span /><span />
        </div>
        <h2 className="rw-loading-stage">{stage}</h2>
        {detail ? <div className="rw-loading-detail rw-mono">{detail}</div> : null}
        <div
          className={`rw-progress ${pct === null ? 'rw-progress-indeterminate' : ''}`}
          role="progressbar"
          aria-valuenow={pct === null ? undefined : pct}
        >
          <div
            className="rw-progress-fill"
            style={pct === null ? undefined : { width: `${pct}%` }}
          />
        </div>
        <div className="rw-loading-flavor" key={flavorIdx}>
          {FLAVOR_LINES[flavorIdx % FLAVOR_LINES.length]}&hellip;
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- ready */

/** Poll the mutable playerState at ~10Hz into React state for the HUD text. */
function usePlayerSnapshot() {
  const [snap, setSnap] = useState(() => ({ ...playerState }));
  useEffect(() => {
    const id = setInterval(() => {
      setSnap((prev) => {
        // Cheap change check to skip re-renders while standing still.
        if (
          prev.focusedBuilding === playerState.focusedBuilding &&
          prev.activeHazard === playerState.activeHazard &&
          prev.locked === playerState.locked &&
          prev.targetedBug === playerState.targetedBug &&
          prev.uiFocused === playerState.uiFocused &&
          prev.nearbyNpc === playerState.nearbyNpc &&
          Math.abs(prev.dangerLevel - playerState.dangerLevel) < 0.01
        ) return prev;
        return { ...playerState };
      });
    }, 100);
    return () => clearInterval(id);
  }, []);
  return snap;
}

/** Defensive quest tracker — another agent owns quest generation, shape may vary. */
function QuestTracker({ quest }) {
  if (!quest || typeof quest !== 'object') return null;
  const label =
    quest.text || quest.label || quest.title || quest.objective || quest.description;
  if (!label) return null;
  const current =
    typeof quest.current === 'number' ? quest.current
      : typeof quest.progress === 'number' ? quest.progress
      : null;
  const total =
    typeof quest.total === 'number' ? quest.total
      : typeof quest.count === 'number' ? quest.count
      : null;

  return (
    <div className="rw-quest">
      <div className="rw-quest-label">{label}</div>
      {current !== null && total !== null ? (
        <div className="rw-quest-progress rw-mono">{current}/{total}</div>
      ) : null}
    </div>
  );
}

function WorldHUD({ world, chase = null, npcs = [], questState = null, onReset }) {
  const snap = usePlayerSnapshot();
  const vignetteRef = useRef(null);

  // Danger vignette: drive opacity from playerState on rAF for smoothness,
  // easing toward the target so it never pops.
  useEffect(() => {
    let raf = 0;
    let current = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const target = Math.max(0, Math.min(1, playerState.dangerLevel || 0));
      current += (target - current) * 0.08;
      if (vignetteRef.current) {
        vignetteRef.current.style.opacity = current < 0.005 ? '0' : String(current);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const layout = world && world.layout ? world.layout : null;
  const buildings = layout && Array.isArray(layout.buildings) ? layout.buildings : [];
  const hazards = world && Array.isArray(world.hazards) ? world.hazards : [];
  const stats = (world && world.stats) || { files: buildings.length, issues: 0, prs: 0, risks: 0 };
  const repo = world && world.repo;
  const repoName = repo ? `${repo.owner}/${repo.repo}` : 'unknown repo';
  const quest = world && world.questSummary;

  const focused = snap.focusedBuilding
    ? buildings.find((b) => b && b.id === snap.focusedBuilding)
    : null;
  const activeHazard = snap.activeHazard
    ? hazards.find((h) => h && h.id === snap.activeHazard)
    : null;

  const hazardCounts = { issue: stats.issues || 0, pr: stats.prs || 0, risk: stats.risks || 0 };
  const hudHidden = !!snap.uiFocused;

  return (
    <div className={`rw-hud ${hudHidden ? 'rw-hud-focused' : ''}`} aria-hidden={hudHidden}>
      {/* danger vignette */}
      <div ref={vignetteRef} className="rw-vignette" aria-hidden="true" />

      {/* crosshair */}
      <div className="rw-crosshair" aria-hidden="true">
        <span className="rw-ch-h" />
        <span className="rw-ch-v" />
        <span className="rw-ch-dot" />
      </div>

      {/* top-left: repo + stats + quest */}
      <div className="rw-panel rw-topleft">
        <div className="rw-repo-name rw-mono">{repoName}</div>
        <div className="rw-stat-row">
          <span className="rw-stat">{stats.files ?? buildings.length} files</span>
          {HAZARD_DOTS.map((d) => (
            <span className="rw-stat" key={d.kind}>
              <span className={`rw-dot ${d.className}`} />
              {hazardCounts[d.kind]} {d.label}
            </span>
          ))}
        </div>
        {world && world.summary ? (
          <div className="rw-summary">{world.summary}</div>
        ) : null}
        <QuestTracker quest={quest} />
      </div>

      {/* top-right: minimap + new repo */}
      <div className="rw-topright">
        <Minimap layout={layout} hazards={hazards} chase={chase} npcs={npcs} questState={questState} size={190} />
        <button
          type="button"
          className="rw-btn rw-btn-ghost rw-newrepo"
          onClick={onReset}
        >
          NEW REPO
        </button>
      </div>

      {/* bottom-left: focused building */}
      {focused ? (
        <div className="rw-panel rw-bottomleft">
          <div className="rw-focus-path rw-mono">{focused.path}</div>
          <div className="rw-focus-meta">
            <span className="rw-lang-swatch" style={{ background: focused.color }} />
            {focused.lang} &nbsp;·&nbsp; {formatBytes(focused.size)}
          </div>
        </div>
      ) : null}

      {/* bottom-center: deploy prompt > hazard context > controls hint */}
      <div className="rw-bottomcenter">
        {snap.targetedBug ? (
          <div className="rw-deploy-prompt">
            <span className="rw-deploy-key">E</span>
            <span className="rw-deploy-text">DEPLOY GREPTILE</span>
          </div>
        ) : activeHazard ? (
          <div className={`rw-hazard-card rw-hazard-${activeHazard.kind}`}>
            <div className="rw-hazard-head">
              <span className="rw-hazard-kind">{activeHazard.kind.toUpperCase()}</span>
              <span className="rw-hazard-sev">
                severity {activeHazard.severity}/10
              </span>
            </div>
            <div className="rw-hazard-title">{activeHazard.title}</div>
            {activeHazard.reason ? (
              <div className="rw-hazard-reason">{activeHazard.reason}</div>
            ) : null}
          </div>
        ) : (
          <div className="rw-hint-bar">
            <kbd>WASD</kbd> move · <kbd>Shift</kbd> sprint · <kbd>F</kbd> fly ·{' '}
            <kbd>Esc</kbd> release cursor
          </div>
        )}
      </div>

      {/* click-to-look prompt when pointer lock is off */}
      {!snap.locked ? (
        <div className="rw-lock-prompt">
          <div className="rw-lock-prompt-inner">click to look around</div>
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- error */

function ErrorScreen({ error, onReset }) {
  const message = error
    ? (typeof error === 'string' ? error : error.message || String(error))
    : 'Something went wrong.';
  return (
    <div className="rw-screen rw-error">
      <div className="rw-bg-sky" aria-hidden="true" />
      <div className="rw-bg-ground" aria-hidden="true" />
      <div className="rw-error-inner rw-panel">
        <div className="rw-error-badge">WORLD GENERATION FAILED</div>
        <p className="rw-error-message rw-mono">{message}</p>
        <button className="rw-btn rw-btn-primary" type="button" onClick={onReset}>
          TRY ANOTHER REPO
        </button>
        <p className="rw-error-hint">
          Public repos work without a token — but GitHub rate limits may require
          setting <code>GITHUB_TOKEN</code> in <code>.env</code>. The{' '}
          <code>demo</code> world always works offline.
        </p>
      </div>
    </div>
  );
}
