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
}
