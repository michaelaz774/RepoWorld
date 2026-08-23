/**
 * CodePanel — floating "see the actual code" panel shown when the player walks
 * up to a focused building. Rendered via drei <Html transform> as a DOM overlay
 * in world space; the parent (Buildings) guarantees at most one is mounted.
 *
 * Styled to match the voxel world: a bright parchment "game UI" panel with a
 * chunky pixel-bevel border, not a glowing neon slab.
 *
 * Fetches the file lazily via fetchCode(building.path). Every state (no loader,
 * loading, error, ready, binary-ish garbage) renders something; nothing throws.
 * All styling is inline (plus one scoped <style> block for the scrollbar
 * pseudo-elements, which cannot be reached via inline styles) — the shared
 * stylesheet is owned elsewhere.
 *
 * SCROLLING (reading the whole file): the panel renders the ENTIRE fetched
 * file (the fetcher itself truncates at ~20k chars — see src/lib/github.js's
 * FILE_CONTENT_MAX) inside a scrollable, chunky-scrollbar viewport, rather
 * than a fixed-height preview. It only becomes clickable/scrollable while the
 * pointer is UNLOCKED (`playerState.locked === false`, i.e. after pressing
 * Esc): while locked, pointerEvents stays 'none' exactly like before, so this
 * invisible-until-unlocked overlay can never eat a WASD move or an E deploy.
 * Every mouse/wheel interaction on the panel stops propagation so a click
 * inside it can't reach `document` and re-trigger PointerLockControls' own
 * click-to-lock listener (see @react-three/drei's PointerLockControls, which
 * listens on `document` for any bubbling click) — without that, clicking the
 * panel to scroll would immediately re-lock the cursor and kill the feature.
 */
import { useEffect, useMemo, useState } from 'react';
import { Billboard, Html } from '@react-three/drei';
import { playerState } from '../lib/playerState.js';
import { langForExt } from '../lib/types.js';

const MAX_LINE_CHARS = 160;
const LOCK_POLL_MS = 100;

/* ------------------------------------------------------------------ */
/* Tiny regex-based highlighter. Best-effort; never throws.            */
/* ------------------------------------------------------------------ */

const HASH_COMMENT_LANGS = new Set(['Python', 'Shell', 'YAML', 'Ruby']);

const KEYWORDS =
  'function|const|let|var|return|if|elif|else|for|while|import|from|export|default|' +
  'class|def|fn|pub|use|mod|new|async|await|try|except|catch|finally|switch|case|' +
  'break|continue|type|interface|struct|enum|impl|trait|package|func|go|public|' +
  'private|protected|static|void|int|float|bool|string|self|this|super|None|null|' +
  'nil|undefined|true|false|True|False|and|or|not|in|is|do|then|end|match|yield|raise|throw';

function buildLineRegex(lang) {
  const comment = HASH_COMMENT_LANGS.has(lang) ? '#.*$' : '\\/\\/.*$|\\/\\*.*?(?:\\*\\/|$)';
  return new RegExp(
    `(?<comment>${comment})` +
      `|(?<string>"(?:[^"\\\\]|\\\\.)*"?|'(?:[^'\\\\]|\\\\.)*'?|\`(?:[^\`\\\\]|\\\\.)*\`?)` +
      `|(?<number>\\b\\d[\\d_]*(?:\\.\\d+)?\\b)` +
      `|(?<keyword>\\b(?:${KEYWORDS})\\b)`,
    'gm'
  );
}

const TOKEN_COLORS = {
  comment: '#6f7d52',
  string: '#a15c2f',
  number: '#3f7d4f',
  keyword: '#1f5fa8',
};

/**
 * Split one line into [{kind, text}] tokens. Guarded: on any surprise it
 * returns the whole line as plain text.
 */
function tokenizeLine(line, regex) {
  try {
    const out = [];
    let last = 0;
    regex.lastIndex = 0;
    let m;
    let guard = 0;
    while ((m = regex.exec(line)) !== null && guard++ < 200) {
      if (m.index > last) out.push({ kind: 'plain', text: line.slice(last, m.index) });
      const groups = m.groups || {};
      const kind =
        groups.comment != null
          ? 'comment'
          : groups.string != null
            ? 'string'
            : groups.number != null
              ? 'number'
              : 'keyword';
      out.push({ kind, text: m[0] });
      last = m.index + (m[0].length || 1);
      if (m[0].length === 0) regex.lastIndex++;
    }
    if (last < line.length) out.push({ kind: 'plain', text: line.slice(last) });
    return out;
  } catch {
    return [{ kind: 'plain', text: String(line) }];
  }
}

function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '?';
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

/** Stop a DOM event from bubbling up to `document`, where drei's
 *  PointerLockControls listens for any click to re-engage pointer lock. */
function eatEvent(e) {
  e.stopPropagation();
}

/* ------------------------------------------------------------------ */
/* Inline styles (Agent 10 owns the shared stylesheet — none used here) */
/* ------------------------------------------------------------------ */

const S = {
  panel: {
    width: '460px',
    maxHeight: '480px',
    display: 'flex',
    flexDirection: 'column',
    background: 'rgba(10, 14, 22, 0.88)',
    border: '1px solid rgba(120, 160, 220, 0.35)',
    borderRadius: '10px',
    boxShadow: '0 0 24px rgba(60, 120, 255, 0.25)',
    color: '#d4d9e2',
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: '11px',
    lineHeight: '1.45',
    backdropFilter: 'blur(3px)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: '10px',
    padding: '7px 12px',
    borderBottom: '1px solid rgba(120, 160, 220, 0.25)',
    background: 'rgba(30, 42, 66, 0.6)',
    flexShrink: 0,
  },
  path: {
    color: '#9ecbff',
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  },
  meta: { color: '#8b96a8', whiteSpace: 'nowrap', flexShrink: 0 },
  scrollBody: {
    padding: '8px 0',
    overflowY: 'auto',
    overflowX: 'hidden',
    flex: '1 1 auto',
    minHeight: 0,
  },
  row: { display: 'flex', whiteSpace: 'pre', overflow: 'hidden' },
  lineNo: {
    width: '34px',
    flexShrink: 0,
    textAlign: 'right',
    paddingRight: '10px',
    color: '#4a5568',
    position: 'sticky',
    left: 0,
  },
  msg: { padding: '18px 14px', color: '#8b96a8', fontStyle: 'italic' },
  hint: {
    flexShrink: 0,
    padding: '5px 12px',
    borderTop: '1px solid rgba(120, 160, 220, 0.25)',
    background: 'rgba(30, 42, 66, 0.6)',
    color: '#ffe08a',
    fontSize: '10.5px',
    fontWeight: 600,
    letterSpacing: '0.02em',
    textAlign: 'center',
  },
};

// Chunky, high-contrast, voxel-styled scrollbar — a thin/invisible one would
// read as "not scrollable" to a first-time player. Scoped by class name since
// ::-webkit-scrollbar can't be reached from an inline `style` prop.
const SCROLLBAR_CSS = `
.rw-codepanel-scroll::-webkit-scrollbar { width: 14px; }
.rw-codepanel-scroll::-webkit-scrollbar-track { background: #141a26; border-left: 2px solid #000; }
.rw-codepanel-scroll::-webkit-scrollbar-thumb {
  background: #4d76b8;
  border: 2px solid #0a0e16;
  box-shadow: inset 1px 1px 0 rgba(255,255,255,0.25);
}
.rw-codepanel-scroll::-webkit-scrollbar-thumb:hover { background: #6b90cf; }
`;

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

/**
 * @param {{building: import('../lib/types.js').Building, fetchCode?: ((path: string) => Promise<string>)|null, position?: [number, number, number]|null}} props
 */
export default function CodePanel({ building, fetchCode = null, position = null }) {
  const [state, setState] = useState({ status: 'loading', text: '' });

  // Polled (not subscribed — playerState is plain mutable data, see its own
  // header comment) so pointerEvents/the hint can react to Esc without the
  // parent (Buildings.jsx) needing to know or care about pointer lock at all.
  const [locked, setLocked] = useState(playerState.locked);
  useEffect(() => {
    const id = setInterval(() => {
      setLocked((prev) => (prev !== playerState.locked ? playerState.locked : prev));
    }, LOCK_POLL_MS);
    return () => clearInterval(id);
  }, []);

  const path = building && building.path ? String(building.path) : '';

  // Place the panel between the building and where the player stood when it
  // opened (computed once per building), unless an explicit position is given.
  const pos = useMemo(() => {
    if (Array.isArray(position) && position.length === 3) return position;
    const b = building || {};
    const bx = Number.isFinite(b.x) ? b.x : 0;
    const bz = Number.isFinite(b.z) ? b.z : 0;
    let dx = playerState.x - bx;
    let dz = playerState.z - bz;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const half = Math.max(b.w || 2, b.d || 2) / 2;
    const y = Math.min(Math.max((b.height || 4) * 0.45, 2.3), 5.5);
    return [bx + dx * (half + 1.7), y, bz + dz * (half + 1.7)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [building && building.id, position]);

  useEffect(() => {
    let alive = true;
    if (!path) {
      setState({ status: 'error', text: '' });
      return undefined;
    }
    if (typeof fetchCode !== 'function') {
      setState({ status: 'nofetch', text: '' });
      return undefined;
    }
    setState({ status: 'loading', text: '' });
    Promise.resolve()
      .then(() => fetchCode(path))
      .then((text) => {
        if (!alive) return;
        if (text == null) setState({ status: 'nofetch', text: '' });
        else setState({ status: 'ready', text: String(text) });
      })
      .catch(() => {
        if (alive) setState({ status: 'error', text: '' });
      });
    return () => {
      alive = false;
    };
  }, [path, fetchCode]);

  const lang = building
    ? building.lang || langForExt(building.ext)
    : 'Other';

  // Full file, not a preview: the fetcher already caps this at ~20k chars
  // (FILE_CONTENT_MAX in src/lib/github.js), so rendering every line here is
  // bounded. The scrollable viewport (S.scrollBody) is what makes that many
  // lines readable instead of an unusable wall of text.
  const { lines, totalLines, regex } = useMemo(() => {
    let all = [];
    try {
      all = String(state.text || '').replace(/\r\n/g, '\n').split('\n');
    } catch {
      all = [];
    }
    return {
      lines: all.map((l) => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…` : l)),
      totalLines: all.length,
      regex: buildLineRegex(lang),
    };
  }, [state.text, lang]);

  if (!building) return null;

  let body;
  if (state.status === 'loading') {
    body = <div style={S.msg}>loading {building.name || path}…</div>;
  } else if (state.status === 'error') {
    body = <div style={S.msg}>couldn&apos;t load this file — it still stands tall.</div>;
  } else if (state.status === 'nofetch') {
    body = (
      <div style={S.msg}>
        source not available in this session — {formatSize(building.size)} of {lang}.
      </div>
    );
  } else {
    body = (
      <div className="rw-codepanel-scroll" style={S.scrollBody} onWheel={eatEvent}>
        {lines.map((line, i) => (
          <div key={i} style={S.row}>
            <span style={S.lineNo}>{i + 1}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {tokenizeLine(line, regex).map((tok, j) =>
                tok.kind === 'plain' ? (
                  <span key={j}>{tok.text}</span>
                ) : (
                  <span key={j} style={{ color: TOKEN_COLORS[tok.kind] || '#d4d9e2' }}>
                    {tok.text}
                  </span>
                )
              )}
              {line === '' ? ' ' : ''}
            </span>
          </div>
        ))}
      </div>
    );
  }

  // pointerEvents follows pointer-lock state: 'none' while locked (so this
  // world-space overlay can never swallow a WASD move or an E deploy), and
  // 'auto' only once the player has pressed Esc — that's also the only time
  // clicking/scrolling the panel is possible at all.
  const interactive = !locked;

  return (
    <Billboard position={pos}>
      <Html
        transform
        distanceFactor={6}
        occlude
        pointerEvents={interactive ? 'auto' : 'none'}
        style={{ pointerEvents: interactive ? 'auto' : 'none' }}
      >
        <style>{SCROLLBAR_CSS}</style>
        <div
          style={{
            ...S.panel,
            pointerEvents: interactive ? 'auto' : 'none',
            userSelect: interactive ? 'text' : 'none',
            cursor: interactive ? 'default' : undefined,
          }}
          // Every one of these stops the event from ever reaching `document`,
          // where drei's <PointerLockControls> listens for a bubbling click to
          // re-engage pointer lock — without this, clicking the panel to
          // scroll would instantly re-lock the cursor and undo itself.
          onClick={eatEvent}
          onMouseDown={eatEvent}
          onMouseUp={eatEvent}
          onWheel={eatEvent}
          onPointerDown={eatEvent}
        >
          <div style={S.header}>
            <span style={S.path}>{path || '(unknown file)'}</span>
            <span style={S.meta}>
              {lang} · {formatSize(building.size)}
              {state.status === 'ready' ? ` · ${totalLines} lines` : ''}
            </span>
          </div>
          {body}
          {!interactive && state.status === 'ready' ? (
            <div style={S.hint}>Esc to free cursor · scroll to read</div>
          ) : null}
        </div>
      </Html>
    </Billboard>
  );
}
