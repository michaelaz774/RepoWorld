/**
 * Tiny store that carries NPC dialogue OUT of the react-three-fiber tree.
 *
 * Why this exists: NPCs.jsx lives inside <Canvas>, where the active reconciler is R3F's,
 * not react-dom's. Rendering DOM there — even through react-dom's createPortal — makes R3F
 * try to resolve `<div>`/`<span>` as THREE objects and throw
 * "R3F: Span is not part of the THREE namespace!". So the 3D side publishes dialogue state
 * here, and NpcDialogueHost (mounted by App.jsx, outside the Canvas) renders the actual DOM.
 */

let current = null;
const listeners = new Set();

/** @param {null | {npc: Object, lineIndex: number, onNext: Function, onClose: Function}} next */
export function setDialogue(next) {
  current = next;
  for (const fn of listeners) fn(current);
}

export function getDialogue() {
  return current;
}

export function subscribeDialogue(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
