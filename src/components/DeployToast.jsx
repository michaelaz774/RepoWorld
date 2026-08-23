/**
 * DeployToast — the "Greptile is on the way" confirmation.
 *
 * Pressing E used to give no feedback at all: the creature might be most of a city away,
 * so for several seconds nothing visibly happened and the key felt broken. This watches
 * `playerState.lastDeploy` (stamped by Targeting.jsx on a successful deploy) and shows a
 * short banner naming the bug that was targeted, so the action always confirms itself.
 *
 * Polls on an interval rather than per-frame: this is a DOM overlay and must not re-render
 * at 60fps. It also can't live in useFrame — that loop is paused whenever the browser tab
 * is hidden, and the toast should still be correct when the player comes back.
 */
import { useEffect, useRef, useState } from 'react';
import { playerState } from '../lib/playerState.js';

const VISIBLE_MS = 3600;
const POLL_MS = 120;

/** Pull a human-readable label for the deployed-on bug out of the chase state. */
function describeBug(chase, bugId) {
  if (!chase || !bugId) return null;
  const bugs = Array.isArray(chase.bugs) ? chase.bugs : null;
  if (!bugs) return null;
  const bug = bugs.find((b) => b && b.id === bugId);
  if (!bug) return null;
  const title = typeof bug.title === 'string' && bug.title ? bug.title : bug.id;
  return { title, severity: Number.isFinite(bug.severity) ? bug.severity : null, kind: bug.kind };
}

export default function DeployToast({ chase = null }) {
  const [toast, setToast] = useState(null);
  const lastSeenRef = useRef(0);
  const chaseRef = useRef(chase);
  chaseRef.current = chase;

  useEffect(() => {
    const id = setInterval(() => {
      const deploy = playerState.lastDeploy;
      if (deploy && deploy.at > lastSeenRef.current) {
        lastSeenRef.current = deploy.at;
        setToast({
          at: deploy.at,
          bug: describeBug(chaseRef.current, deploy.bugId),
        });
        return;
      }
      // Expire on the same tick loop so we never leave a banner stuck on screen.
      setToast((cur) =>
        cur && performance.now() - cur.at > VISIBLE_MS ? null : cur
      );
    }, POLL_MS);
    return () => clearInterval(id);
  }, []);

  if (!toast) return null;

  const title = toast.bug?.title || 'that bug';
  const severity = toast.bug?.severity;

  return (
    <div style={styles.wrap} aria-live="polite">
      <div style={styles.box}>
        <div style={styles.headline}>
          <span style={styles.spark}>▲</span> GREPTILE IS ON THE WAY
        </div>
        <div style={styles.detail}>
          Hunting <strong style={styles.target}>{title}</strong>
          {severity != null ? <span style={styles.sev}> · severity {severity}</span> : null}
        </div>
        <div style={styles.hint}>Follow the green beacon to watch the fix land</div>
      </div>
    </div>
  );
}

// Inline styles so this component owns its own look and doesn't collide with the shared
// stylesheet. Chunky bevelled block panel, matching the voxel UI language.
const styles = {
  wrap: {
    position: 'fixed',
    top: '96px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 25,
    pointerEvents: 'none',
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  },
  box: {
    background: '#5b9a3b',
    border: '3px solid #2a241d',
    borderRadius: '3px',
    padding: '12px 20px',
    textAlign: 'center',
    color: '#f4fbe8',
    boxShadow: 'inset 2px 2px 0 rgba(255,255,255,0.45), inset -2px -2px 0 rgba(0,0,0,0.38)',
  },
  headline: {
    fontWeight: 900,
    fontSize: '17px',
    letterSpacing: '0.02em',
    textShadow: '1px 1px 0 rgba(0,0,0,0.55)',
  },
  spark: { color: '#d7ffb0' },
  detail: { marginTop: '5px', fontSize: '14px', fontWeight: 700 },
  target: { color: '#ffffff' },
  sev: { color: '#e8ffd2', fontWeight: 700 },
  hint: {
    marginTop: '4px',
    fontSize: '12px',
    fontWeight: 700,
    color: '#dff3c8',
  },
};
