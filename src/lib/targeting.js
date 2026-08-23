/**
 * Targeting — pure aim-assist logic for picking the bug under the player's
 * crosshair. No three.js imports so this stays unit-testable in plain vitest.
 *
 * `camera` is a plain object, NOT a THREE.Camera:
 *   { x, y, z, dirX, dirY, dirZ }  — world position + (needn't be unit-length)
 *   view direction.
 *
 * `candidates` is an array of plain targetable points:
 *   { id, x, y, z, radius }        — radius is accepted for API symmetry with
 *   the caller's candidate shape but is not used in selection (aim assist is
 *   purely angle/distance based here; a bigger radius does not enlarge the
 *   effective cone).
 *
 * Selection rule: among candidates within `opts.maxDistance` that are in
 * front of the camera and inside a `opts.coneDegrees`-half-angle cone around
 * the view direction, pick the one with the smallest ANGULAR offset from the
 * view direction (not merely the nearest by straight-line distance) — this
 * is what makes aiming at a small, far-away target feel forgiving. Ties are
 * broken first by distance, then by id (ascending, string-compared), so
 * results are fully deterministic for identical input.
 *
 * Degenerate input handling (documented, not thrown):
 *   - Zero-length (or missing/non-finite) view direction falls back to the
 *     world "look down -Z" convention used elsewhere in this codebase
 *     (see Player.jsx's default spawn heading).
 *   - A candidate exactly at the camera position has an undefined direction;
 *     it is treated as a trivial angle-0 / in-front match rather than
 *     thrown out, so it can still be targeted rather than crashing the loop.
 *   - Non-finite (NaN/undefined/etc) coordinates on the camera make
 *     pickTarget bail out to `null`; non-finite coordinates on a single
 *     candidate cause just that candidate to be skipped.
 */

const DEFAULT_MAX_DISTANCE = 60;
const DEFAULT_CONE_DEGREES = 12;
/** How many points to test along a candidate's beacon column. 9 is dense enough that a
 *  tall beam has no gaps the crosshair can slip through, and cheap enough to run over
 *  every bug on a throttled frame. */
const BEAM_SAMPLES = 9;
const DEG_TO_RAD = Math.PI / 180;
const EPS = 1e-9;

function isFiniteNum(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

/** Normalized view direction, with a safe "looking down -Z" fallback. */
function viewDir(camera) {
  const dx = camera && camera.dirX;
  const dy = camera && camera.dirY;
  const dz = camera && camera.dirZ;
  if (!isFiniteNum(dx) || !isFiniteNum(dy) || !isFiniteNum(dz)) return { x: 0, y: 0, z: -1 };
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(len > 1e-8)) return { x: 0, y: 0, z: -1 };
  return { x: dx / len, y: dy / len, z: dz / len };
}

/**
 * Delta + distance from camera to point. Returns null if any coordinate is
 * non-finite (caller decides how to treat that).
 */
function delta(camera, point) {
  const cx = camera && camera.x, cy = camera && camera.y, cz = camera && camera.z;
  const px = point && point.x, py = point && point.y, pz = point && point.z;
  if (!isFiniteNum(cx) || !isFiniteNum(cy) || !isFiniteNum(cz) ||
      !isFiniteNum(px) || !isFiniteNum(py) || !isFiniteNum(pz)) {
    return null;
  }
  const dx = px - cx, dy = py - cy, dz = pz - cz;
  return { dx, dy, dz, dist: Math.sqrt(dx * dx + dy * dy + dz * dz) };
}

/**
 * Angular offset (radians, [0, pi]) between the camera's view direction and
 * the direction from camera to point. Never throws, never returns NaN:
 *   - invalid coordinates -> Math.PI (treated as "as far off-target as possible")
 *   - point coincident with camera -> 0 (treated as dead-on)
 */
export function angularOffset(camera, point) {
  const d = delta(camera, point);
  if (!d) return Math.PI;
  if (!(d.dist > EPS)) return 0;
  const v = viewDir(camera);
  const nx = d.dx / d.dist, ny = d.dy / d.dist, nz = d.dz / d.dist;
  let dot = v.x * nx + v.y * ny + v.z * nz;
  if (dot > 1) dot = 1; else if (dot < -1) dot = -1;
  return Math.acos(dot);
}

/**
 * True if `point` lies in the camera's forward half-space. Never throws:
 *   - invalid coordinates -> false
 *   - point coincident with camera -> true (nothing to be "behind")
 */
export function isInFront(camera, point) {
  const d = delta(camera, point);
  if (!d) return false;
  if (!(d.dist > EPS)) return true;
  const v = viewDir(camera);
  const nx = d.dx / d.dist, ny = d.dy / d.dist, nz = d.dz / d.dist;
  const dot = v.x * nx + v.y * ny + v.z * nz;
  return dot > 0;
}

/**
 * Pick the best target id out of `candidates`, or null if none qualify.
 * @param {{x:number,y:number,z:number,dirX:number,dirY:number,dirZ:number}} camera
 * @param {Array<{id:*, x:number, y:number, z:number, radius?:number}>} candidates
 * @param {{maxDistance?:number, coneDegrees?:number}} [opts]
 * @returns {*} the winning candidate's id, or null
 */
export function pickTarget(camera, candidates, opts = {}) {
  if (!camera || !Array.isArray(candidates) || candidates.length === 0) return null;

  const cx = camera.x, cy = camera.y, cz = camera.z;
  if (!isFiniteNum(cx) || !isFiniteNum(cy) || !isFiniteNum(cz)) return null;

  const maxDistance = isFiniteNum(opts.maxDistance) ? opts.maxDistance : DEFAULT_MAX_DISTANCE;
  const coneDegrees = isFiniteNum(opts.coneDegrees) ? opts.coneDegrees : DEFAULT_CONE_DEGREES;
  const coneRad = coneDegrees * DEG_TO_RAD;
  const v = viewDir(camera);

  let bestId = null;
  let bestAngle = Infinity;
  let bestDist = Infinity;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!c) continue;
    const px = c.x, py = c.y, pz = c.z;
    if (!isFiniteNum(px) || !isFiniteNum(py) || !isFiniteNum(pz)) continue;

    const dx = px - cx, dy = py - cy, dz = pz - cz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > maxDistance) continue;

    // A bug is a small object on the ground, but it carries a tall beacon column. Aiming
    // is measured against the whole vertical segment (bug -> top of its beam), so putting
    // the crosshair anywhere on the beam counts as aiming at the bug. That lets the cone
    // stay tight — you must actually point at the thing — while still being practical at
    // range, where the bug itself is only a few pixels tall.
    const beam = isFiniteNum(c.beamHeight) && c.beamHeight > 0 ? c.beamHeight : 0;
    const samples = beam > 0 ? BEAM_SAMPLES : 1;

    let angle = Infinity;
    let sampleDist = dist;
    for (let s = 0; s < samples; s++) {
      const t = samples === 1 ? 0 : s / (samples - 1);
      const sy = py + beam * t;
      const ddy = sy - cy;
      const d2 = Math.sqrt(dx * dx + ddy * ddy + dz * dz);

      let a;
      if (!(d2 > EPS)) {
        // Sample sits exactly at the camera position — undefined direction; treat as
        // dead-on rather than dividing by zero.
        a = 0;
      } else {
        const nx = dx / d2, ny = ddy / d2, nz = dz / d2;
        let dot = v.x * nx + v.y * ny + v.z * nz;
        if (dot > 1) dot = 1; else if (dot < -1) dot = -1;
        if (dot <= 0) continue; // this sample is behind the camera
        a = Math.acos(dot);
      }
      if (a < angle) {
        angle = a;
        sampleDist = d2;
      }
    }
    if (!isFiniteNum(angle)) continue; // every sample was behind the camera
    if (angle > coneRad) continue;
    void sampleDist;

    const id = c.id;
    let takeIt = false;
    if (angle < bestAngle - EPS) {
      takeIt = true;
    } else if (Math.abs(angle - bestAngle) <= EPS) {
      if (dist < bestDist - EPS) {
        takeIt = true;
      } else if (Math.abs(dist - bestDist) <= EPS) {
        takeIt = bestId === null || String(id) < String(bestId);
      }
    }
    if (takeIt) {
      bestAngle = angle;
      bestDist = dist;
      bestId = id;
    }
  }

  return bestId;
}
