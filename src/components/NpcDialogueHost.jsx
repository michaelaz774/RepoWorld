/**
 * Renders the NPC dialogue box in the normal react-dom tree.
 *
 * Must be mounted OUTSIDE <Canvas>. NPCs.jsx lives inside the R3F tree, where DOM elements
 * can't be rendered (R3F resolves every JSX tag against the THREE namespace, so a <span>
 * throws "Span is not part of the THREE namespace"). NPCs.jsx therefore publishes dialogue
 * state to dialogueStore, and this component — mounted by App.jsx — renders it.
 */
import { useEffect, useState } from 'react';
import { getDialogue, subscribeDialogue } from '../lib/dialogueStore.js';
import './npc.css';

export default function NpcDialogueHost() {
  const [dialogue, setDialogue] = useState(getDialogue);

  useEffect(() => subscribeDialogue(setDialogue), []);

  if (!dialogue || !dialogue.npc) return null;

  const { npc, lineIndex, onNext, onClose } = dialogue;
  const lines = Array.isArray(npc.lines) ? npc.lines : [];
  const line = lines[lineIndex] || '';
  const isLast = lineIndex >= lines.length - 1;

  return (
    <div className="npc-dialogue-backdrop">
      <div className="npc-dialogue-box">
        <p className="npc-dialogue-name">
          {npc.name || 'Local'}{' '}
          <span className="npc-dialogue-role">· {npc.role || 'Resident'}</span>
        </p>
        <p className="npc-dialogue-text">{line}</p>
        <div className="npc-dialogue-actions">
          <button
            type="button"
            className="npc-dialogue-btn"
            onClick={isLast ? onClose : onNext}
          >
            {isLast ? 'Close' : 'Next ▸'}
          </button>
          <span className="npc-dialogue-hint">[T] continue · [Esc] close</span>
        </div>
      </div>
    </div>
  );
}
