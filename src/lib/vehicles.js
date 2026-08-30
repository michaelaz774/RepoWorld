/**
 * vehicles.js — drivable cars: placement + kinematics.
 *
 * Pure logic only (no three.js imports) so it is fully unit-testable, same
 * posture as crowd.js/chase.js. The renderer (src/components/Cars.jsx) owns
 * every mesh; this module owns where a car starts and how it moves.
 *
 * Placement is deterministic — cars are chosen from the road network by
 * hashing stable seed strings, never Math.random() — so the same repo always
 * parks the same cars in the same spots, matching the rest of the world.
 *
 * MODEL: a bicycle-ish arcade car. Speed is a scalar along the car's heading;
 * steering rotates the heading at a rate proportional to how fast you are
 * already going (you cannot pivot in place), and reverses sign in reverse so
 * backing up steers the way a real car does. There is no drift/slip: this is
 * a toy for crossing the city quickly, not a driving sim.
 *
 * Units match the world: metres-ish, seconds. A street is 6-8 units wide and a
 * district spans ~240, so top speed is deliberately well above the 26 u/s
 * sprint in Player.jsx.
 */

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

export const CAR_LENGTH = 4.2;   // matches the parked cars in StreetProps.jsx
export const CAR_WIDTH = 1.8;
/** Collision radius — the car is treated as a circle, like the player capsule. */
export const CAR_RADIUS = 1.5;

// Speed reference from the rest of the world: pedestrians walk 1.2-1.6, the
// player walks 6 and sprints 26 (Player.jsx). A car has to beat sprinting to be
// worth getting into, without being unsteerable on a 4-wide street.
const MAX_SPEED = 30;            // u/s forward
const MAX_REVERSE = 12;          // u/s backward
const BOOST_MULT = 1.45;         // Shift -> ~44 u/s
const ACCEL = 26;                // u/s^2 under throttle
const BRAKE = 46;                // u/s^2 under active braking (throttle opposes motion)
const HANDBRAKE = 70;            // u/s^2 with Space
const DRAG = 3.4;                // u/s^2 coasting deceleration (plus a linear term)
const DRAG_LINEAR = 0.12;        // fraction of speed shed per second while coasting
const STEER_RATE = 1.9;          // rad/s at the steering sweet spot
const STEER_SPEED_REF = 12;      // u/s at which steering is fully effective
const MAX_DT = 0.05;             // clamp so a hitch can't tunnel a car through a wall
const STOP_EPS = 0.05;           // below this speed, snap to a standstill

/** Ride height of the car body's origin (bottom-pivot voxel, see Ground.jsx). */
export const CAR_BASE_Y = 0;

/* ------------------------------------------------------------------ */
/* Deterministic hashing (FNV-1a, same as Ground.jsx's hashStr)        */
/* ------------------------------------------------------------------ */

/** @param {string} str @returns {number} uint32 */
export function hashStr(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Paint colors, distinct from the parked-car palette so drivables read as special. */
export const DRIVABLE_COLORS = ['#e8622a', '#2fae8f', '#b043c9'];

/* ------------------------------------------------------------------ */
/* Placement                                                           */
/* ------------------------------------------------------------------ */

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Axis-aligned footprint overlap test against every building, with padding. */
function insideAnyBuilding(x, z, buildings, pad) {
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    if (!b || !isFiniteNum(b.x) || !isFiniteNum(b.z)) continue;
    const hw = (isFiniteNum(b.w) && b.w > 0 ? b.w : 2) / 2 + pad;
    const hd = (isFiniteNum(b.d) && b.d > 0 ? b.d : 2) / 2 + pad;
    if (Math.abs(x - b.x) <= hw && Math.abs(z - b.z) <= hd) return true;
  }
  return false;
}

/**
 * Candidate parking spots along one road segment: a point in each lane, spaced
 * out along the centerline, with the heading that lane runs in.
 *
 * Roads are always axis-aligned (see RoadSegment in types.js), so "along the
 * road" is exactly world X or world Z and the lane offset is the perpendicular.
 */
function* roadSpots(road, index) {
  const x1 = isFiniteNum(road.x1) ? road.x1 : 0;
  const z1 = isFiniteNum(road.z1) ? road.z1 : 0;
  const x2 = isFiniteNum(road.x2) ? road.x2 : 0;
  const z2 = isFiniteNum(road.z2) ? road.z2 : 0;
  const dx = x2 - x1;
  const dz = z2 - z1;
  const len = Math.hypot(dx, dz);
  if (len < CAR_LENGTH * 2) return;

  const ux = dx / len;
  const uz = dz / len;
  const px = -uz;            // unit perpendicular
  const pz = ux;
  const halfW = (isFiniteNum(road.width) && road.width > 0 ? road.width : 6) / 2;
  // Sit in a lane rather than on the centerline, but never hanging off the kerb.
  // Streets are 4 wide and arterials 10 (layout.js), so on a street this is
  // barely an offset at all — which is correct, a 1.8-wide car IS the street.
  const laneOffset = Math.max(0, Math.min(halfW / 2, halfW - CAR_WIDTH * 0.6));
  // Heading: yaw such that (sin(yaw), cos(yaw)) points along the road. The
  // renderer's car rig faces -Z at yaw 0, matching Player.jsx's yaw convention.
  const forwardYaw = Math.atan2(-ux, -uz);
  const id = road.id != null ? String(road.id) : `road${index}`;
  const arterial = road.kind === 'arterial';

  const step = Math.max(CAR_LENGTH * 3, len / 4);
  for (let t = CAR_LENGTH; t <= len - CAR_LENGTH; t += step) {
    for (const side of [-1, 1]) {
      yield {
        seed: `${id}:drive:${Math.round(t)}:${side}`,
        x: x1 + ux * t + px * side * laneOffset,
        z: z1 + uz * t + pz * side * laneOffset,
        // Face the way traffic on that side would run.
        yaw: side < 0 ? forwardYaw : forwardYaw + Math.PI,
        arterial,
      };
    }
  }
}

/**
 * Pick `count` drivable cars, parked on real roads, nearest the spawn point so
 * the player finds one without hunting for it.
 *
 * @param {import('./types.js').CityLayout|null} layout
 * @param {{x:number,z:number}} spawn
 * @param {number} count
 * @returns {{id:string,x:number,z:number,yaw:number,speed:number,color:string}[]}
 */
export function placeCars(layout, spawn = { x: 0, z: 0 }, count = 3) {
  const n = Math.max(0, Math.floor(count));
  if (!layout || n === 0) return [];
  const roads = Array.isArray(layout.roads) ? layout.roads : [];
  const buildings = Array.isArray(layout.buildings) ? layout.buildings : [];
  const sx = isFiniteNum(spawn?.x) ? spawn.x : 0;
  const sz = isFiniteNum(spawn?.z) ? spawn.z : 0;

  const candidates = [];
  for (let r = 0; r < roads.length; r++) {
    const road = roads[r];
    if (!road) continue;
    for (const spot of roadSpots(road, r)) {
      // Cars are wide; keep a full car-width of clearance from any facade.
      if (insideAnyBuilding(spot.x, spot.z, buildings, CAR_RADIUS)) continue;
      const dx = spot.x - sx;
      const dz = spot.z - sz;
      candidates.push({ ...spot, dist: Math.hypot(dx, dz) });
    }
  }

  // Arterials first, then nearest, then a stable hash tiebreak so ordering never
  // depends on the array order the layout happened to emit.
  //
  // Arterials are 10 units wide against a street's 4 (layout.js), and the car is
  // 1.8 wide: on a street you have well under a car-width of room either side and
  // you scrape a facade on the first corner. Parking on the wide roads costs a
  // short walk to the beacon and buys a road you can actually steer on.
  candidates.sort((a, b) =>
    (Number(b.arterial) - Number(a.arterial)) ||
    (a.dist - b.dist) ||
    (hashStr(a.seed) - hashStr(b.seed))
  );

  // Spread the picks out — three cars bumper to bumper on one street is worse
  // than three cars a block apart.
  const MIN_GAP = 18;
  const chosen = [];
  for (let i = 0; i < candidates.length && chosen.length < n; i++) {
    const c = candidates[i];
    let clear = true;
    for (let j = 0; j < chosen.length; j++) {
      if (Math.hypot(c.x - chosen[j].x, c.z - chosen[j].z) < MIN_GAP) { clear = false; break; }
    }
    if (clear) chosen.push(c);
  }
  // A tiny city may not have enough well-separated spots; backfill rather than
  // returning fewer cars than asked for.
  for (let i = 0; i < candidates.length && chosen.length < n; i++) {
    if (!chosen.includes(candidates[i])) chosen.push(candidates[i]);
  }

  return chosen.slice(0, n).map((c, i) => ({
    id: `car-${i}`,
    x: c.x,
    z: c.z,
    yaw: c.yaw,
    speed: 0,
    color: DRIVABLE_COLORS[hashStr(c.seed + ':color') % DRIVABLE_COLORS.length],
  }));
}

/* ------------------------------------------------------------------ */
/* Kinematics                                                          */
/* ------------------------------------------------------------------ */

/**
 * Advance one car by `dt` seconds.
 *
 * Mutates and returns `car` (matching crowd.js/chase.js, which mutate their
 * sim state in place rather than allocating per frame).
 *
 * @param {{x:number,z:number,yaw:number,speed:number}} car
 * @param {{throttle:number,steer:number,boost:boolean,handbrake:boolean}} input
 *   throttle  +1 forward, -1 back/brake, 0 coast
 *   steer     +1 right, -1 left, 0 straight
 * @param {number} dt seconds
 */
export function stepVehicle(car, input = {}, dt = 0) {
  if (!car) return car;
  const step = Math.min(isFiniteNum(dt) ? dt : 0, MAX_DT);
  if (step <= 0) return car;

  const throttle = clamp(isFiniteNum(input.throttle) ? input.throttle : 0, -1, 1);
  const steer = clamp(isFiniteNum(input.steer) ? input.steer : 0, -1, 1);
  const topSpeed = input.boost ? MAX_SPEED * BOOST_MULT : MAX_SPEED;

  let speed = isFiniteNum(car.speed) ? car.speed : 0;

  if (input.handbrake) {
    speed = approach(speed, 0, HANDBRAKE * step);
  } else if (throttle > 0) {
    // Pressing forward while rolling backward is braking, not accelerating.
    const rate = speed < 0 ? BRAKE : ACCEL;
    speed = Math.min(speed + rate * throttle * step, topSpeed);
  } else if (throttle < 0) {
    const rate = speed > 0 ? BRAKE : ACCEL;
    speed = Math.max(speed + rate * throttle * step, -MAX_REVERSE);
  } else {
    speed = approach(speed, 0, DRAG * step);
    speed -= speed * DRAG_LINEAR * step;
  }
  if (Math.abs(speed) < STOP_EPS) speed = 0;

  // Steering authority ramps in with speed and never lets the car spin on the
  // spot; in reverse the geometry flips, same as a real car.
  if (steer !== 0 && speed !== 0) {
    const grip = Math.min(1, Math.abs(speed) / STEER_SPEED_REF);
    const dir = speed < 0 ? -1 : 1;
    car.yaw = wrapAngle(car.yaw - steer * STEER_RATE * grip * dir * step);
  }

  // yaw 0 faces -Z, matching Player.jsx's `Math.atan2(-dir.x, -dir.z)`.
  const fx = -Math.sin(car.yaw);
  const fz = -Math.cos(car.yaw);
  car.x += fx * speed * step;
  car.z += fz * speed * step;
  car.speed = speed;
  return car;
}

/** Unit forward vector for a yaw, in the same convention as stepVehicle. */
export function headingVector(yaw) {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

/* ------------------------------------------------------------------ */
/* Collision                                                           */
/* ------------------------------------------------------------------ */

/**
 * Push a car out of any building it has driven into, and scrub the speed it
 * lost in the crash. Circle-vs-AABB, resolved on the shallower axis so the car
 * slides along a facade instead of sticking to it.
 *
 * @param {{x:number,z:number,speed:number}} car
 * @param {import('./types.js').Building[]} buildings candidates (pre-filtered by
 *   the caller's spatial grid — this does not iterate the whole city)
 * @returns {boolean} true if a collision was resolved
 */
export function resolveCarCollision(car, buildings) {
  if (!car || !Array.isArray(buildings)) return false;
  let hit = false;
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    if (!b || !isFiniteNum(b.x) || !isFiniteNum(b.z)) continue;
    const hx = (isFiniteNum(b.w) && b.w > 0 ? b.w : 2) / 2 + CAR_RADIUS;
    const hz = (isFiniteNum(b.d) && b.d > 0 ? b.d : 2) / 2 + CAR_RADIUS;
    const dx = car.x - b.x;
    const dz = car.z - b.z;
    if (dx <= -hx || dx >= hx || dz <= -hz || dz >= hz) continue;

    // Overlap depth on each axis; escape via the cheaper one.
    const penX = hx - Math.abs(dx);
    const penZ = hz - Math.abs(dz);
    if (penX < penZ) car.x = b.x + (dx >= 0 ? hx : -hx);
    else car.z = b.z + (dz >= 0 ? hz : -hz);
    hit = true;
  }
  if (hit) car.speed = isFiniteNum(car.speed) ? car.speed * 0.3 : 0;
  return hit;
}

/**
 * Nearest car to a point within `maxDist`, or null. Used for the "press to
 * drive" prompt.
 *
 * @param {{id:string,x:number,z:number}[]} cars
 * @returns {{car:Object,distance:number}|null}
 */
export function nearestCar(cars, x, z, maxDist = 6) {
  if (!Array.isArray(cars)) return null;
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i];
    if (!c || !isFiniteNum(c.x) || !isFiniteNum(c.z)) continue;
    const d = Math.hypot(c.x - x, c.z - z);
    if (d < bestDist && d <= maxDist) { best = c; bestDist = d; }
  }
  return best ? { car: best, distance: bestDist } : null;
}

/**
 * A clear spot beside the car to stand the player on when they get out —
 * driver's side, falling back to the far side and then the roof-ish nose if
 * both flanks are blocked.
 *
 * @returns {{x:number,z:number}}
 */
export function exitPosition(car, buildings = []) {
  const yaw = isFiniteNum(car?.yaw) ? car.yaw : 0;
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  // Right-hand perpendicular of the heading.
  const rx = -fz;
  const rz = fx;
  const gap = CAR_WIDTH * 0.5 + 1.2;
  const options = [
    { x: car.x - rx * gap, z: car.z - rz * gap },
    { x: car.x + rx * gap, z: car.z + rz * gap },
    { x: car.x + fx * (CAR_LENGTH * 0.5 + 1.2), z: car.z + fz * (CAR_LENGTH * 0.5 + 1.2) },
  ];
  for (const o of options) {
    if (!insideAnyBuilding(o.x, o.z, buildings, 0.8)) return o;
  }
  return options[0];
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** Move `v` toward `target` by at most `maxDelta`. */
function approach(v, target, maxDelta) {
  if (v > target) return Math.max(target, v - maxDelta);
  if (v < target) return Math.min(target, v + maxDelta);
  return target;
}

/** Wrap an angle into (-PI, PI] so yaw never grows without bound. */
export function wrapAngle(a) {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x <= -Math.PI) x += Math.PI * 2;
  return x;
}
