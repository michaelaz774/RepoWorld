/**
 * ReviewPanel — the payoff moment: the instant a bug dies, this opens and
 * shows the player what the problem actually was and what the fix is, like
 * a real code review. A plain DOM overlay (NOT in-world 3D).
 *
 * Data comes from src/lib/fixes.js (`fetchFix` -> Greptile, falling back to
 * the deterministic `mockFix`). Styling lives in ./reviewPanel.css, owned
 * entirely by this component (bright, blocky, Minecraft-style voxel UI —
 * see VOXEL.md: chunky hard-edged borders with a raised bevel, flat colors,
 * big readable type, no glow/neon/glassmorphism).
 *
 * Player-control handoff: while open this sets playerState.uiFocused = true
 * so movement/pointer-lock stand down, and it is restored to false on close
 * AND on unmount — a stuck true here would freeze the player and kill the
 * demo, so every code path that can end the "open" state clears it.
 */
import { useEffect, useRef, useState } from 'react';
import { fetchFix, mockFix, summarizeForLearner } from '../lib/fixes.js';
import { acquireUiFocus, releaseUiFocus } from '../lib/playerState.js';
import './reviewPanel.css';

const KIND_META = {
  issue: { chip: 'rwrp-kind-issue', head: 'rwrp-head-issue', label: 'Bug Report' },
  pr: { chip: 'rwrp-kind-pr', head: 'rwrp-head-pr', label: 'Open Pull Request' },
  risk: { chip: 'rwrp-kind-risk', head: 'rwrp-head-risk', label: 'Risk Finding' },
};

function kindMeta(kind) {
  return KIND_META[kind] || KIND_META.issue;
}

function clampSeverity(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(10, Math.max(1, Math.round(v))) : 1;
}

/** Split a code snippet into non-empty display lines (never throws on odd input). */
function codeLines(text) {
  const s = typeof text === 'string' ? text : '';
  return s.replace(/\r\n/g, '\n').split('\n');
}

const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export default function ReviewPanel({ repo = null, hazard = null, onClose = null, onApprove = null }) {
  const panelRef = useRef(null);
  const previouslyFocused = useRef(null);
  const [phase, setPhase] = useState('loading'); // 'loading' | 'ready'
  const [fix, setFix] = useState(null);
  const [approved, setApproved] = useState(false);

  const hazardKey = hazard && typeof hazard === 'object' ? (hazard.id || hazard.path || '') : '';

  // --- fetch the fix whenever a new hazard opens ---------------------
  useEffect(() => {
    if (!hazard) return undefined;
    let cancelled = false;
    setPhase('loading');
    setFix(null);
    setApproved(false);

    fetchFix(repo, hazard)
      .then((f) => {
        if (!cancelled) {
          setFix(f);
          setPhase('ready');
        }
      })
      .catch(() => {
        // fetchFix never throws, but never leave the player stuck regardless.
        if (!cancelled) {
          setFix(mockFix(hazard));
          setPhase('ready');
        }
      });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hazardKey, repo]);

  // --- own the player's control focus while open ----------------------
  useEffect(() => {
    if (!hazard) return undefined;
    acquireUiFocus('review');
    previouslyFocused.current = (typeof document !== 'undefined' && document.activeElement) || null;

    let raf = null;
    if (typeof requestAnimationFrame === 'function') {
      raf = requestAnimationFrame(() => {
        if (panelRef.current) panelRef.current.focus();
      });
    }

    return () => {
      if (raf != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      // Critical: always stand control back up, no matter how we got here
      // (close button, Approve, Escape, or the hazard prop just changing/unmounting).
      releaseUiFocus('review');
      const prev = previouslyFocused.current;
      if (prev && typeof prev.focus === 'function') {
        try { prev.focus(); } catch { /* element may no longer be focusable/attached */ }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hazardKey]);

  // --- Escape to close + Tab focus trap --------------------------------
  useEffect(() => {
    if (!hazard) return undefined;

    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (onClose) onClose();
        return;
      }
      if (e.key === 'Tab') {
        const root = panelRef.current;
        if (!root) return;
        const nodes = Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
          (el) => !el.disabled && el.offsetParent !== null
        );
        if (nodes.length === 0) {
          e.preventDefault();
          return;
        }
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !root.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hazardKey, onClose]);

  if (!hazard) return null;

  const kind = ['issue', 'pr', 'risk'].includes(hazard.kind) ? hazard.kind : 'issue';
  const meta = kindMeta(kind);
  const severity = clampSeverity(hazard.severity);
  const title = (hazard.title && String(hazard.title)) || '(untitled)';
  const path = (hazard.path && String(hazard.path)) || '(unplaced)';
  const reason = (hazard.reason && String(hazard.reason)) || 'No further detail was recorded for this one.';

  function handleClose() {
    if (onClose) onClose();
  }

  function handleApprove() {
    if (approved) return;
    setApproved(true);
    if (onApprove) onApprove(hazard, fix);
  }

  return (
    <div
      className="rwrp-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        className="rwrp-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Code review: ${title}`}
        tabIndex={-1}
      >
        <div className={`rwrp-head ${meta.head}`}>
          <span className={`rwrp-kind-chip ${meta.chip}`}>{meta.label}</span>
          <div className="rwrp-head-title">{title}</div>
          <button
            type="button"
            className="rwrp-close-x"
            onClick={handleClose}
            aria-label="Close review panel"
            title="Close (Esc)"
          >
            X
          </button>
        </div>

        <div className="rwrp-body">
          {phase === 'loading' && (
            <div className="rwrp-loading">
              <div className="rwrp-loading-blocks" aria-hidden="true">
                <span /><span /><span /><span />
              </div>
              <div className="rwrp-loading-text">Greptile is analyzing the fix&hellip;</div>
              <div className="rwrp-loading-sub">Deploying a kaiju against {path}</div>
            </div>
          )}

          {phase === 'ready' && !approved && fix && (
            <>
              <div className="rwrp-section">
                <div className="rwrp-section-label">The Bug</div>
                <div className="rwrp-meta-row">
                  <span className="rwrp-file-badge" title={path}>{path}</span>
                  <span className="rwrp-sev" title={`Severity ${severity} / 10`}>
                    SEV
                    <span className="rwrp-sev-blocks" aria-hidden="true">
                      {Array.from({ length: 10 }, (_, i) => (
                        <span key={i} className={`rwrp-sev-block${i < severity ? ' on' : ''}`} />
                      ))}
                    </span>
                    {severity}/10
                  </span>
                </div>
                <div className="rwrp-reason">{reason}</div>
              </div>

              <div className="rwrp-section">
                <div className="rwrp-section-label">The Fix — {fix.title}</div>
                <p style={{ fontSize: 13.5, lineHeight: 1.55, margin: '0 0 10px' }}>{fix.problem}</p>
                <div className="rwrp-diff">
                  <div className="rwrp-diff-block rwrp-diff-before">
                    <div className="rwrp-diff-head">Before</div>
                    <pre className="rwrp-code">
                      {codeLines(fix.before).map((line, i) => (
                        <span className="rwrp-code-line" key={i}>{line || ' '}</span>
                      ))}
                    </pre>
                  </div>
                  <div className="rwrp-diff-block rwrp-diff-after">
                    <div className="rwrp-diff-head">After</div>
                    <pre className="rwrp-code">
                      {codeLines(fix.after).map((line, i) => (
                        <span className="rwrp-code-line" key={i}>{line || ' '}</span>
                      ))}
                    </pre>
                  </div>
                </div>
              </div>

              <div className="rwrp-section" style={{ marginBottom: 0 }}>
                <div className="rwrp-learn">
                  <div className="rwrp-learn-label">
                    <span className="rwrp-learn-icon" aria-hidden="true" />
                    Why this matters
                  </div>
                  <div className="rwrp-learn-text">{summarizeForLearner(fix)}</div>
                </div>
              </div>
            </>
          )}

          {approved && fix && (
            <div className="rwrp-success">
              <div className="rwrp-success-badge" aria-hidden="true">&#10003;</div>
              <div className="rwrp-success-title">PR Merged — {path} is safe now!</div>
              <div className="rwrp-success-body">
                Greptile's fix for &ldquo;{fix.title}&rdquo; just shipped. The kaiju got its bug, the code got
                better, and the city is a little safer. That's the whole loop: find it, understand it, fix it.
              </div>
            </div>
          )}
        </div>

        <div className="rwrp-foot">
          <button type="button" className="rwrp-btn rwrp-btn-close" onClick={handleClose}>
            {approved ? 'Back to the City' : 'Close'}
          </button>
          {!approved && (
            <button
              type="button"
              className="rwrp-btn rwrp-btn-approve"
              onClick={handleApprove}
              disabled={phase !== 'ready'}
            >
              Approve &amp; Merge PR
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
