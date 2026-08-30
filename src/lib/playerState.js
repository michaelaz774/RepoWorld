/**
 * Shared mutable player/world state, read+written inside useFrame loops.
 *
 * This is intentionally NOT React state: it is mutated every frame and must not
 * trigger re-renders. Components read fields directly in useFrame.
 * HUD elements that need to display these values should poll on an interval
 * or via useFrame + a ref, never by subscribing.
 */
export const playerState = {
  /** Camera/player world position */
  x: 0,
  y: 2,
  z: 0,
  /** Yaw in radians (0 = looking down -Z) */
  yaw: 0,
  /** True while pointer lock is engaged */
  locked: false,
  /** Building.id the player is currently closest to & facing, or null */
  focusedBuilding: null,
  /** Distance to focusedBuilding in world units */
  focusedDistance: Infinity,
  /** 0..1 — how deep inside hazard radii the player currently is (drives HUD vignette) */
  dangerLevel: 0,
  /** Hazard.id of the strongest hazard currently affecting the player, or null */
  activeHazard: null,
  /** Number of distinct hazards the player has walked into this session */
  hazardsVisited: 0,

  // ---- Interaction / gameplay -------------------------------------------------
  /** Bug id the player's crosshair is currently on (in range + in front), or null */
  targetedBug: null,
  /** Distance to targetedBug in world units */
  targetedBugDistance: Infinity,
  /** Set true for ONE frame when the player presses the deploy key on a valid target.
   *  The chase simulation consumes it and resets it to false. */
  deployRequested: false,
  /** NPC id the player is close enough to talk to, or null */
  nearbyNpc: null,
  /** Car id the player is close enough to get into, or null (see Cars.jsx) */
  nearbyCar: null,
  /** True while the player is close enough to talk to the wizard (see Wizard.jsx) */
  nearbyWizard: false,
  /** True only while the player's cursor is in a text field, so letter keys are
   *  text and not movement. Distinct from `uiFocused`: the wizard chat stays
   *  open while you walk around, and only steals the keyboard while you type. */
  typing: false,
  /** True while the wizard chat is docked on screen. Not a focus flag — the
   *  world keeps running; the HUD just hides its "press R" prompt. */
  wizardChatOpen: false,
  /** The wizard's live world position, published each frame by Wizard.jsx so the
   *  minimap can mark him. He walks, so these are not constants. */
  wizardX: null,
  wizardZ: null,
  /** True while the player is driving a car. Player.jsx stands down and Cars.jsx
   *  takes over the camera AND publishing x/y/z/yaw. */
  driving: false,
  /** True while a full-screen panel (review or dialogue) has focus. Player controls
   *  and pointer lock should stand down while this is true. */
  uiFocused: false,

  /** Set by Targeting each time the player successfully deploys Greptile:
   *  `{ bugId, at }` where `at` is a monotonic timestamp. The deploy toast watches
   *  this so it can confirm the action fired without extra prop plumbing. */
  lastDeploy: null,
};

// Exposed for debugging/inspection from the console (read-only in practice).
if (typeof window !== 'undefined') window.__playerState = playerState;

/** Reset between world loads. */
export function resetPlayerState(spawn = { x: 0, y: 2, z: 0 }) {
  playerState.x = spawn.x;
  playerState.y = spawn.y;
  playerState.z = spawn.z;
  playerState.yaw = 0;
  playerState.focusedBuilding = null;
  playerState.focusedDistance = Infinity;
  playerState.dangerLevel = 0;
  playerState.activeHazard = null;
  playerState.hazardsVisited = 0;
  playerState.nearbyCar = null;
  playerState.nearbyWizard = false;
  playerState.typing = false;
  playerState.wizardChatOpen = false;
  playerState.wizardX = null;
  playerState.wizardZ = null;
  playerState.driving = false;
  uiFocusOwners.clear();
  playerState.uiFocused = false;
}

/* ------------------------------------------------------------------ */
/* UI focus ownership                                                  */
/* ------------------------------------------------------------------ */

/**
 * `uiFocused` is read by half the app to decide whether to accept input, but it
 * is a single boolean with no notion of WHO focused it. Two panels can be open
 * at once — kill a bug while the wizard chat is up and ReviewPanel mounts on
 * top — and whichever unmounts last used to write `false`, unfreezing the world
 * underneath a panel that is still on screen.
 *
 * Panels claim and release by name instead; the flag stays true while anyone
 * still holds it.
 */
const uiFocusOwners = new Set();

export function acquireUiFocus(owner) {
  uiFocusOwners.add(owner);
  playerState.uiFocused = true;
}

export function releaseUiFocus(owner) {
  uiFocusOwners.delete(owner);
  playerState.uiFocused = uiFocusOwners.size > 0;
}

/** Test/debug helper: who currently holds UI focus. */
export function uiFocusHolders() {
  return [...uiFocusOwners];
}
