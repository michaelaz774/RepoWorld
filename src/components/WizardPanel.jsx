/**
 * WizardPanel — the wizard's chat, and the app's first text input inside the
 * 3D phase.
 *
 * Lives OUTSIDE <Canvas> (mounted from App.jsx) because R3F resolves DOM tags
 * against the THREE namespace — the same reason NpcDialogueHost exists.
 *
 * NON-BLOCKING BY DESIGN. This chat is a dock, not a modal: the wizard is a
 * walking companion, so the world keeps running and you keep full movement and
 * mouse look while it is on screen. It therefore does NOT claim `uiFocused` —
 * that flag freezes the player and is for true modals (review panel, NPC
 * dialogue).
 *
 * Instead there are two modes, the way a game chat works:
 *   walking — the panel is on screen, WASD moves you, the mouse looks around.
 *   typing  — Enter (or clicking the field) puts the cursor in the box. Letter
 *             keys are now text, so movement is suspended via
 *             `playerState.typing`, which Player/Cars/NPCs check. Enter sends
 *             and hands control straight back to the game; Esc leaves typing.
 *
 * Without that split, "walk forward" typed at the wizard would toggle fly mode
 * on the "f" and enter a car on the "g" — every movement key is also a letter.
 *
 * The API key is the player's own, held in React state for this session only —
 * never localStorage, never sent anywhere but api.anthropic.com. See
 * wizardClient.js for why that is the chosen trade.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { playerState } from '../lib/playerState.js';
import { WIZARD_MODEL, looksLikeApiKey } from '../lib/wizardClient.js';
import './wizard.css';

const SUGGESTIONS = [
  'What is this repo, in one breath?',
  'Which building here is the most dangerous, and why?',
  'Take me to the riskiest file and tell me what is wrong with it.',
];

/** Friendly label for a tool call, shown while the wizard works. */
function toolLabel(name) {
  switch (name) {
    case 'read_file': return 'reading the stones';
    case 'search_paths': case 'list_files': return 'consulting the ledger';
    case 'describe_building': return 'inspecting a building';
    case 'describe_district': return 'surveying the district';
    case 'get_risks': return 'counting the monsters';
    case 'list_imports': return 'tracing the arcs';
    case 'list_live_bugs': return 'watching the streets';
    case 'locate': return 'reading the map';
    case 'move_to': case 'follow_player': return 'walking';
    case 'player_position': return 'looking for you';
    default: return 'thinking';
  }
}

export default function WizardPanel({
  open,
  onClose,
  apiKey,
  onApiKey,
  workspaceId,
  onWorkspaceId,
  makeSession,
  onStatus,
}) {
  const [messages, setMessages] = useState([]);   // {role:'user'|'wizard'|'error', text}
  const [draft, setDraft] = useState('');
  const [keyDraft, setKeyDraft] = useState('');
  const [wsDraft, setWsDraft] = useState('');
  // Identity-linked keys (personal / service-account) are rejected with a 400
  // until the request names a workspace. We only ask once the API says so,
  // rather than putting a field in front of everyone who does not need it.
  const [needsWorkspace, setNeedsWorkspace] = useState(false);
  const [typing, setTyping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState(null);

  const panelRef = useRef(null);
  const inputRef = useRef(null);
  const logRef = useRef(null);
  const sessionRef = useRef(null);
  const abortRef = useRef(null);

  /* ---- typing mode: the only thing that takes the keyboard ---- */
  const startTyping = useCallback(() => {
    // Release the mouse so the caret and the Send button are clickable. Pointer
    // lock is re-acquired by drei's document click handler when you click the
    // world again.
    if (document.pointerLockElement && document.exitPointerLock) document.exitPointerLock();
    // Set the mode directly rather than waiting for the focus event to tell us:
    // a browser fires no focus event at all when the window itself is not
    // focused, and the keyboard-driven path must not depend on that. The
    // onFocus/onBlur handlers below still cover the mouse path, and both
    // converge on the same state.
    setTyping(true);
    // A timer, not requestAnimationFrame: rAF is paused in background/hidden
    // tabs, so an rAF-based focus silently never runs (Scene.jsx hit the same
    // thing with canvas init).
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const stopTyping = useCallback(() => {
    setTyping(false);
    inputRef.current?.blur();
  }, []);

  // playerState.typing is the flag Player/Cars/NPCs read. Mirror the DOM focus
  // into it, and make very sure it is cleared on unmount — a stuck `true` would
  // leave the player unable to move with no visible cause.
  useEffect(() => {
    playerState.typing = typing;
  }, [typing]);
  useEffect(() => () => { playerState.typing = false; }, []);

  // Let the HUD hide its "press R to speak" prompt while the chat is docked —
  // otherwise it sits underneath the panel's own hint bar.
  useEffect(() => {
    playerState.wizardChatOpen = !!open;
  }, [open]);
  useEffect(() => () => { playerState.wizardChatOpen = false; }, []);

  // Closing the panel must never leave the player stuck in typing mode. React
  // does not reliably fire onBlur when the input unmounts, so this is the
  // backstop: a stuck `typing === true` means the player cannot move and there
  // is nothing on screen explaining why. Worth the set-state-in-effect warning.
  useEffect(() => {
    if (!open) { playerState.typing = false; setTyping((t) => (t ? false : t)); }
  }, [open]);

  // The key gate is the one case worth focusing immediately: there is nothing
  // else to do with the panel until a key is entered.
  useEffect(() => {
    if (open && !apiKey) startTyping();
  }, [open, apiKey, startTyping]);

  /* ---- Enter starts typing; Escape steps back out, then closes ---- */
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();   // capture phase, so NPCs.jsx never sees it
        if (typing) stopTyping();
        else onClose();
        return;
      }
      // Enter from the world (not from inside the field) drops you into the box.
      // Works on the key gate too — its input is the only thing to do there.
      if (e.key === 'Enter' && !typing) {
        e.preventDefault();
        e.stopPropagation();
        startTyping();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose, typing, startTyping, stopTyping]);

  /* ---- abort any in-flight request when the panel closes ---- */
  useEffect(() => {
    if (open) return undefined;
    return () => { abortRef.current?.abort(); };
  }, [open]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages, tool]);

  useEffect(() => { onStatus?.(busy ? toolLabel(tool || '') + '…' : null); }, [busy, tool, onStatus]);

  const ask = useCallback(async (text) => {
    const question = String(text || '').trim();
    if (!question || busy) return;

    if (!sessionRef.current) {
      try {
        sessionRef.current = makeSession();
      } catch (err) {
        setMessages((m) => [...m, { role: 'error', text: err?.message || 'Could not start a session.' }]);
        return;
      }
    }

    setMessages((m) => [...m, { role: 'user', text: question }, { role: 'wizard', text: '' }]);
    setDraft('');
    // Hand movement straight back: the reply streams in while you walk, which is
    // the whole point of a companion you can talk to on the move. Enter again to
    // ask a follow-up.
    stopTyping();
    setBusy(true);
    setTool(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await sessionRef.current.send(question, {
        signal: controller.signal,
        onToolCall: (name) => setTool(name),
        onText: (chunk) => {
          setMessages((m) => {
            const next = [...m];
            const last = next[next.length - 1];
            if (last && last.role === 'wizard') next[next.length - 1] = { ...last, text: last.text + chunk };
            return next;
          });
        },
      });
      setMessages((m) => {
        // A reply that was only tool calls would leave an empty bubble.
        const next = [...m];
        const last = next[next.length - 1];
        if (last && last.role === 'wizard' && !last.text) {
          next[next.length - 1] = { ...last, text: '…the wizard says nothing.' };
        }
        return next;
      });
    } catch (err) {
      if (err?.kind === 'aborted') {
        setMessages((m) => m.filter((msg, i) => !(i === m.length - 1 && msg.role === 'wizard' && !msg.text)));
      } else {
        setMessages((m) => {
          const next = m.filter((msg, i) => !(i === m.length - 1 && msg.role === 'wizard' && !msg.text));
          return [...next, { role: 'error', text: err?.message || 'Something went wrong.' }];
        });
        if (err?.kind === 'auth') onApiKey(null);
        if (err?.kind === 'workspace') setNeedsWorkspace(true);
      }
    } finally {
      setBusy(false);
      setTool(null);
      abortRef.current = null;
    }
  }, [busy, makeSession, onApiKey, stopTyping]);

  // A new key or workspace means a new session (and a new system prompt).
  useEffect(() => { sessionRef.current = null; }, [apiKey, workspaceId]);

  if (!open) return null;

  const needsKey = !apiKey;

  return (
    <div className="rwz-dock">
      {/* Clicks inside the panel must not reach `document`, or drei's
          PointerLockControls re-captures the mouse the moment you click the
          input and the caret vanishes. */}
      <div
        className={`rwz-panel ${typing ? '' : 'rwz-panel-idle'}`}
        ref={panelRef}
        role="dialog"
        aria-label="The Wise Wizard"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rwz-head">
          <span className="rwz-title">THE WISE WIZARD</span>
          <span className="rwz-sub">{needsKey ? 'awaiting a key' : WIZARD_MODEL}</span>
          <button type="button" className="rwz-close" onClick={onClose}>ESC ✕</button>
        </div>

        {needsKey ? (
          <div className="rwz-gate">
            <p>
              The wizard is piloted by a live Claude model. Paste your own Anthropic API key to
              wake him.
            </p>
            <form
              className="rwz-form"
              style={{ padding: 0, border: 'none', background: 'none' }}
              onSubmit={(e) => {
                e.preventDefault();
                const k = keyDraft.trim();
                if (k) { onApiKey(k); setKeyDraft(''); }
              }}
            >
              <input
                ref={inputRef}
                className="rwz-input"
                type="password"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                placeholder="sk-ant-…"
                onFocus={() => setTyping(true)}
                onBlur={() => setTyping(false)}
                spellCheck={false}
                autoComplete="off"
                aria-label="Anthropic API key"
              />
              <button className="rwz-send" type="submit" disabled={!keyDraft.trim()}>WAKE HIM</button>
            </form>
            <p className="rwz-gate-note" style={{ marginTop: 12 }}>
              {keyDraft && !looksLikeApiKey(keyDraft)
                ? 'That does not look like an Anthropic key — they start with sk-ant-.'
                : 'Kept in this tab only: held in memory for this session, never saved to disk and never sent anywhere but api.anthropic.com. Reloading the page forgets it.'}
            </p>
          </div>
        ) : (
          <>
            <div className="rwz-log" ref={logRef}>
              {messages.length === 0 ? (
                <div className="rwz-msg rwz-msg-wizard">
                  <p style={{ margin: '0 0 10px' }}>
                    You look lost, traveller. I have lived in this city since it was first
                    compiled — ask me about any building in it.
                  </p>
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="rwz-send"
                      style={{ display: 'block', marginTop: 6, background: 'transparent', fontWeight: 400, textAlign: 'left' }}
                      onClick={() => ask(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              ) : (
                messages.map((m, i) => (
                  <div key={i} className={`rwz-msg rwz-msg-${m.role}`}>{m.text}</div>
                ))
              )}
              {busy ? <div className="rwz-tools">{toolLabel(tool || '')}…</div> : null}
            </div>

            {needsWorkspace && !workspaceId ? (
              <form
                className="rwz-form"
                style={{ borderTop: '4px solid var(--rwz-panel-edge)', background: 'rgba(176,108,255,0.12)' }}
                onSubmit={(e) => {
                  e.preventDefault();
                  const w = wsDraft.trim();
                  if (w) { onWorkspaceId(w); setWsDraft(''); setNeedsWorkspace(false); }
                }}
              >
                <input
                  className="rwz-input"
                  type="text"
                  value={wsDraft}
                  onChange={(e) => setWsDraft(e.target.value)}
                  placeholder="workspace id (from console.anthropic.com → Settings → Workspaces)"
                  onFocus={() => setTyping(true)}
                  onBlur={() => setTyping(false)}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="Anthropic workspace ID"
                />
                <button className="rwz-send" type="submit" disabled={!wsDraft.trim()}>SET</button>
              </form>
            ) : null}

            <form
              className="rwz-form"
              onSubmit={(e) => { e.preventDefault(); ask(draft); }}
            >
              <input
                ref={inputRef}
                className="rwz-input"
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Ask the wizard about your code…"
                onFocus={() => setTyping(true)}
                onBlur={() => setTyping(false)}
                spellCheck={false}
                autoComplete="off"
                aria-label="Message the wizard"
                disabled={busy}
              />
              <button className="rwz-send" type="submit" disabled={busy || !draft.trim()}>
                {busy ? '…' : 'ASK'}
              </button>
            </form>
            <div className="rwz-modehint">
              {typing
                ? <><kbd>Enter</kbd> send · <kbd>Esc</kbd> back to walking</>
                : <><kbd>Enter</kbd> to type · <kbd>WASD</kbd> still moves you · <kbd>Esc</kbd> close</>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
