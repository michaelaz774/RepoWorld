import { describe, it, expect } from 'vitest';
import {
  placeCars,
  stepVehicle,
  resolveCarCollision,
  nearestCar,
  exitPosition,
  headingVector,
  wrapAngle,
  hashStr,
  CAR_LENGTH,
  CAR_WIDTH,
  CAR_RADIUS,
  DRIVABLE_COLORS,
} from './vehicles.js';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** Two arterials and two streets, axis-aligned and integer-snapped like buildCity emits. */
function roadGrid() {
  return [
    { id: 'a-h', x1: -100, z1: 0, x2: 100, z2: 0, width: 10, kind: 'arterial' },
    { id: 'a-v', x1: 0, z1: -100, x2: 0, z2: 100, width: 10, kind: 'arterial' },
    { id: 's-h', x1: -60, z1: 40, x2: 60, z2: 40, width: 4, kind: 'street' },
    { id: 's-v', x1: 40, z1: -60, x2: 40, z2: 60, width: 4, kind: 'street' },
  ];
}

function building(id, x, z, w = 6, d = 6, height = 12) {
  return { id, x, z, w, d, height };
}

function layout(roads = roadGrid(), buildings = []) {
  return { roads, buildings, districts: [], plots: [], paths: [], bounds: {} };
}

function car(overrides = {}) {
  return { id: 'car-0', x: 0, z: 0, yaw: 0, speed: 0, color: '#fff', ...overrides };
}

/** Run `n` fixed steps and return the car. */
function drive(c, input, n, dt = 1 / 60) {
  for (let i = 0; i < n; i++) stepVehicle(c, input, dt);
  return c;
}

/* ------------------------------------------------------------------ */
/* placeCars                                                           */
/* ------------------------------------------------------------------ */

describe('placeCars', () => {
  it('places the requested number of cars on a normal city', () => {
    const cars = placeCars(layout(), { x: 0, z: 0 }, 3);
    expect(cars).toHaveLength(3);
    for (const c of cars) {
      expect(Number.isFinite(c.x)).toBe(true);
      expect(Number.isFinite(c.z)).toBe(true);
      expect(Number.isFinite(c.yaw)).toBe(true);
      expect(c.speed).toBe(0);
      expect(DRIVABLE_COLORS).toContain(c.color);
    }
    expect(new Set(cars.map((c) => c.id)).size).toBe(3);
  });

  it('never throws on degenerate input', () => {
    expect(() => placeCars(null, { x: 0, z: 0 }, 3)).not.toThrow();
    expect(() => placeCars(undefined, undefined, 3)).not.toThrow();
    expect(() => placeCars(layout([]), { x: 0, z: 0 }, 3)).not.toThrow();
    expect(() => placeCars(layout(null), { x: 0, z: 0 }, 3)).not.toThrow();
    expect(() => placeCars(layout(), { x: NaN, z: NaN }, 3)).not.toThrow();
    expect(placeCars(null, { x: 0, z: 0 }, 3)).toEqual([]);
    expect(placeCars(layout([]), { x: 0, z: 0 }, 3)).toEqual([]);
    expect(placeCars(layout(), { x: 0, z: 0 }, 0)).toEqual([]);
    expect(placeCars(layout(), { x: 0, z: 0 }, -5)).toEqual([]);
  });

  it('tolerates roads with missing or malformed coordinates', () => {
    const roads = [
      null,
      { id: 'bad', x1: NaN, z1: 0, x2: 10, z2: 0, width: 4, kind: 'street' },
      { id: 'short', x1: 0, z1: 0, x2: 1, z2: 0, width: 4, kind: 'street' },
      { id: 'ok', x1: -50, z1: 0, x2: 50, z2: 0, width: 10, kind: 'arterial' },
    ];
    const cars = placeCars(layout(roads), { x: 0, z: 0 }, 2);
    expect(cars.length).toBeGreaterThan(0);
    for (const c of cars) {
      expect(Number.isFinite(c.x)).toBe(true);
      expect(Number.isFinite(c.z)).toBe(true);
    }
  });

  it('prefers the wide arterials over narrow streets', () => {
    // Streets are much closer to this spawn than either arterial, so a pure
    // distance sort would pick them; the arterial preference must win.
    const cars = placeCars(layout(), { x: 40, z: 40 }, 3);
    for (const c of cars) {
      const onArterial = Math.abs(c.z) <= 5 || Math.abs(c.x) <= 5;
      expect(onArterial).toBe(true);
    }
  });

  it('keeps cars clear of building footprints', () => {
    const buildings = [building('b1', 0, 20), building('b2', 0, -20), building('b3', 20, 0)];
    const cars = placeCars(layout(roadGrid(), buildings), { x: 0, z: 0 }, 3);
    for (const c of cars) {
      for (const b of buildings) {
        const clearX = Math.abs(c.x - b.x) > b.w / 2 + CAR_RADIUS - 1e-9;
        const clearZ = Math.abs(c.z - b.z) > b.d / 2 + CAR_RADIUS - 1e-9;
        expect(clearX || clearZ).toBe(true);
      }
    }
  });

  it('spreads cars apart rather than stacking them', () => {
    const cars = placeCars(layout(), { x: 0, z: 0 }, 3);
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        expect(Math.hypot(cars[i].x - cars[j].x, cars[i].z - cars[j].z)).toBeGreaterThan(CAR_LENGTH);
      }
    }
  });

  it('sits cars within the road surface, not on the kerb', () => {
    const cars = placeCars(layout(), { x: 0, z: 0 }, 3);
    for (const c of cars) {
      // Every fixture road is centered on an axis; find the one it belongs to.
      const onH = Math.abs(c.z) <= 5 || Math.abs(c.z - 40) <= 2;
      const onV = Math.abs(c.x) <= 5 || Math.abs(c.x - 40) <= 2;
      expect(onH || onV).toBe(true);
    }
  });

  describe('determinism', () => {
    it('same layout and spawn produce identical cars', () => {
      const a = placeCars(layout(), { x: 12, z: -30 }, 3);
      const b = placeCars(layout(), { x: 12, z: -30 }, 3);
      expect(a).toEqual(b);
    });

    it('does not depend on the order roads arrive in', () => {
      const roads = roadGrid();
      const a = placeCars(layout(roads), { x: 0, z: 0 }, 3);
      const b = placeCars(layout([...roads].reverse()), { x: 0, z: 0 }, 3);
      const key = (cars) => cars.map((c) => `${c.x.toFixed(6)},${c.z.toFixed(6)}`).sort();
      expect(key(a)).toEqual(key(b));
    });
  });
});

/* ------------------------------------------------------------------ */
/* stepVehicle                                                         */
/* ------------------------------------------------------------------ */

describe('stepVehicle', () => {
  it('accelerates forward and tops out', () => {
    const c = drive(car(), { throttle: 1 }, 60 * 10);
    expect(c.speed).toBeGreaterThan(25);
    expect(c.speed).toBeLessThanOrEqual(30 + 1e-9);
    // yaw 0 faces -Z, matching Player.jsx's yaw convention.
    expect(c.z).toBeLessThan(0);
    expect(Math.abs(c.x)).toBeLessThan(1e-9);
  });

  it('boost raises the ceiling', () => {
    const plain = drive(car(), { throttle: 1 }, 60 * 10);
    const boosted = drive(car(), { throttle: 1, boost: true }, 60 * 10);
    expect(boosted.speed).toBeGreaterThan(plain.speed);
  });

  it('reverses more slowly than it drives forward', () => {
    const back = drive(car(), { throttle: -1 }, 60 * 10);
    expect(back.speed).toBeLessThan(0);
    expect(Math.abs(back.speed)).toBeLessThan(30);
    expect(back.z).toBeGreaterThan(0);
  });

  it('brakes harder than it coasts', () => {
    const braking = drive(car({ speed: 20 }), { throttle: -1 }, 12);
    const coasting = drive(car({ speed: 20 }), { throttle: 0 }, 12);
    expect(braking.speed).toBeLessThan(coasting.speed);
  });

  it('coasts to a full stop and stays stopped', () => {
    const c = drive(car({ speed: 20 }), { throttle: 0 }, 60 * 30);
    expect(c.speed).toBe(0);
    const restX = c.x;
    const restZ = c.z;
    drive(c, { throttle: 0 }, 60);
    expect(c.x).toBe(restX);
    expect(c.z).toBe(restZ);
  });

  it('handbrake stops faster than braking', () => {
    const hand = drive(car({ speed: 25 }), { handbrake: true }, 10);
    const brake = drive(car({ speed: 25 }), { throttle: -1 }, 10);
    expect(hand.speed).toBeLessThan(brake.speed);
  });

  it('cannot turn while stationary', () => {
    const c = drive(car(), { throttle: 0, steer: 1 }, 120);
    expect(c.yaw).toBe(0);
  });

  it('steers the opposite way in reverse, like a real car', () => {
    const fwd = drive(car({ speed: 15 }), { throttle: 1, steer: 1 }, 30);
    const rev = drive(car({ speed: -10 }), { throttle: -1, steer: 1 }, 30);
    expect(fwd.yaw).toBeLessThan(0);   // steer right turns yaw negative
    expect(rev.yaw).toBeGreaterThan(0);
  });

  it('keeps yaw wrapped no matter how long it circles', () => {
    const c = drive(car({ speed: 25 }), { throttle: 1, steer: 1 }, 60 * 60);
    expect(c.yaw).toBeGreaterThan(-Math.PI - 1e-9);
    expect(c.yaw).toBeLessThanOrEqual(Math.PI + 1e-9);
  });

  it('clamps dt so a frame hitch cannot teleport the car', () => {
    const small = drive(car({ speed: 30 }), { throttle: 1 }, 1, 0.05);
    const huge = drive(car({ speed: 30 }), { throttle: 1 }, 1, 10);
    expect(huge.z).toBeCloseTo(small.z, 10);
  });

  it('ignores zero, negative and non-finite dt', () => {
    for (const dt of [0, -1, NaN, undefined, null]) {
      const c = car({ speed: 10 });
      stepVehicle(c, { throttle: 1 }, dt);
      expect(c.x).toBe(0);
      expect(c.z).toBe(0);
      expect(c.speed).toBe(10);
    }
  });

  it('never produces NaN under garbage input', () => {
    const c = car();
    for (const input of [
      {}, { throttle: NaN, steer: NaN }, { throttle: 'x', steer: {} },
      { throttle: 99, steer: -99 }, { throttle: Infinity, steer: Infinity },
    ]) {
      drive(c, input, 60);
      expect(Number.isFinite(c.x)).toBe(true);
      expect(Number.isFinite(c.z)).toBe(true);
      expect(Number.isFinite(c.yaw)).toBe(true);
      expect(Number.isFinite(c.speed)).toBe(true);
    }
  });

  it('clamps out-of-range throttle and steer to the same result as +-1', () => {
    const wild = drive(car(), { throttle: 99, steer: 99 }, 60);
    const unit = drive(car(), { throttle: 1, steer: 1 }, 60);
    expect(wild.speed).toBeCloseTo(unit.speed, 10);
    expect(wild.yaw).toBeCloseTo(unit.yaw, 10);
  });

  it('returns the same object it was given (mutates in place)', () => {
    const c = car();
    expect(stepVehicle(c, { throttle: 1 }, 1 / 60)).toBe(c);
  });

  it('survives a null car', () => {
    expect(() => stepVehicle(null, { throttle: 1 }, 0.016)).not.toThrow();
  });

  describe('determinism', () => {
    it('identical inputs produce identical trajectories', () => {
      const a = car();
      const b = car();
      const inputs = [
        { throttle: 1, steer: 0 }, { throttle: 1, steer: 1 },
        { throttle: 0, steer: -1 }, { throttle: -1, steer: 0 },
        { throttle: 1, steer: 1, boost: true },
      ];
      const dts = [1 / 60, 1 / 30, 0.02, 0.049, 1 / 120];
      for (let i = 0; i < 500; i++) {
        const input = inputs[i % inputs.length];
        const dt = dts[i % dts.length];
        stepVehicle(a, input, dt);
        stepVehicle(b, input, dt);
      }
      expect(a.x).toBe(b.x);
      expect(a.z).toBe(b.z);
      expect(a.yaw).toBe(b.yaw);
      expect(a.speed).toBe(b.speed);
    });
  });
});

/* ------------------------------------------------------------------ */
/* headingVector / wrapAngle                                           */
/* ------------------------------------------------------------------ */

describe('headingVector', () => {
  it('agrees with the direction stepVehicle actually moves', () => {
    for (const yaw of [0, 0.7, -1.4, Math.PI / 2, 3]) {
      const c = car({ yaw, speed: 10 });
      stepVehicle(c, { throttle: 0 }, 1 / 60);
      const h = headingVector(yaw);
      expect(Math.sign(c.x) || 0).toBe(Math.sign(h.x) || 0);
      expect(Math.sign(c.z) || 0).toBe(Math.sign(h.z) || 0);
    }
  });

  it('is a unit vector', () => {
    for (const yaw of [0, 1, -2.5, Math.PI]) {
      const h = headingVector(yaw);
      expect(Math.hypot(h.x, h.z)).toBeCloseTo(1, 12);
    }
  });

  it('yaw 0 points down -Z, matching Player.jsx', () => {
    const h = headingVector(0);
    expect(h.x).toBeCloseTo(0, 12);
    expect(h.z).toBeCloseTo(-1, 12);
  });
});

describe('wrapAngle', () => {
  it('maps any angle into (-PI, PI]', () => {
    for (const a of [0, Math.PI, -Math.PI, 7, -7, 100, -100]) {
      const w = wrapAngle(a);
      expect(w).toBeGreaterThan(-Math.PI - 1e-12);
      expect(w).toBeLessThanOrEqual(Math.PI + 1e-12);
      expect(Math.abs(Math.sin(w) - Math.sin(a))).toBeLessThan(1e-9);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Collision                                                           */
/* ------------------------------------------------------------------ */

describe('resolveCarCollision', () => {
  it('pushes a car out of a building it drove into', () => {
    const b = building('b', 0, 0, 6, 6);
    const c = car({ x: 1, z: 0.5, speed: 20 });
    expect(resolveCarCollision(c, [b])).toBe(true);
    const outX = Math.abs(c.x) >= 3 + CAR_RADIUS - 1e-9;
    const outZ = Math.abs(c.z) >= 3 + CAR_RADIUS - 1e-9;
    expect(outX || outZ).toBe(true);
  });

  it('scrubs speed on impact but never reverses direction', () => {
    const c = car({ x: 0.5, z: 0, speed: 25 });
    resolveCarCollision(c, [building('b', 0, 0)]);
    expect(c.speed).toBeGreaterThan(0);
    expect(c.speed).toBeLessThan(25);
  });

  it('leaves a car in the clear untouched', () => {
    const c = car({ x: 50, z: 50, speed: 20 });
    expect(resolveCarCollision(c, [building('b', 0, 0)])).toBe(false);
    expect(c.x).toBe(50);
    expect(c.z).toBe(50);
    expect(c.speed).toBe(20);
  });

  it('escapes on the shallower axis so the car slides along a facade', () => {
    // Deep overlap in X, shallow in Z -> should be pushed out in Z.
    const c = car({ x: 0, z: 3 + CAR_RADIUS - 0.2, speed: 10 });
    resolveCarCollision(c, [building('b', 0, 0, 6, 6)]);
    expect(c.x).toBe(0);
    expect(Math.abs(c.z)).toBeCloseTo(3 + CAR_RADIUS, 9);
  });

  it('never throws or NaNs on malformed buildings', () => {
    const c = car({ x: 0, z: 0, speed: 10 });
    expect(() => resolveCarCollision(c, [null, {}, { x: NaN, z: 0 }, undefined])).not.toThrow();
    expect(() => resolveCarCollision(c, null)).not.toThrow();
    expect(() => resolveCarCollision(null, [])).not.toThrow();
    expect(Number.isFinite(c.x)).toBe(true);
    expect(Number.isFinite(c.z)).toBe(true);
  });

  it('a car driven at a wall ends up outside it, every step', () => {
    const b = building('b', 0, -30, 8, 8);
    const c = car({ x: 0, z: 0, yaw: 0, speed: 0 });
    for (let i = 0; i < 600; i++) {
      stepVehicle(c, { throttle: 1 }, 1 / 60);
      resolveCarCollision(c, [b]);
      const clearX = Math.abs(c.x - b.x) >= b.w / 2 + CAR_RADIUS - 1e-6;
      const clearZ = Math.abs(c.z - b.z) >= b.d / 2 + CAR_RADIUS - 1e-6;
      expect(clearX || clearZ).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* nearestCar / exitPosition                                           */
/* ------------------------------------------------------------------ */

describe('nearestCar', () => {
  const cars = [car({ id: 'a', x: 0, z: 0 }), car({ id: 'b', x: 10, z: 0 }), car({ id: 'c', x: 3, z: 4 })];

  it('returns the closest car inside the radius', () => {
    const hit = nearestCar(cars, 1, 0, 6);
    expect(hit.car.id).toBe('a');
    expect(hit.distance).toBeCloseTo(1, 9);
  });

  it('returns null when nothing is in range', () => {
    expect(nearestCar(cars, 100, 100, 6)).toBe(null);
  });

  it('respects the radius boundary', () => {
    expect(nearestCar([car({ id: 'a', x: 5, z: 0 })], 0, 0, 5)).not.toBe(null);
    expect(nearestCar([car({ id: 'a', x: 5.01, z: 0 })], 0, 0, 5)).toBe(null);
  });

  it('never throws on degenerate input', () => {
    expect(nearestCar(null, 0, 0)).toBe(null);
    expect(nearestCar([], 0, 0)).toBe(null);
    expect(nearestCar([null, {}, { x: NaN, z: 0 }], 0, 0)).toBe(null);
  });
});

describe('exitPosition', () => {
  it('puts the player beside the car, clear of the bodywork', () => {
    const c = car({ x: 0, z: 0, yaw: 0 });
    const spot = exitPosition(c, []);
    expect(Math.hypot(spot.x - c.x, spot.z - c.z)).toBeGreaterThan(CAR_WIDTH / 2);
    expect(Number.isFinite(spot.x)).toBe(true);
    expect(Number.isFinite(spot.z)).toBe(true);
  });

  it('avoids a building on the driver side', () => {
    const c = car({ x: 0, z: 0, yaw: 0 });
    // yaw 0 faces -Z, so the driver side is +X; block it.
    const blocked = building('b', 2.1, 0, 2, 8);
    const spot = exitPosition(c, [blocked]);
    const insideX = Math.abs(spot.x - blocked.x) <= blocked.w / 2 + 0.8;
    const insideZ = Math.abs(spot.z - blocked.z) <= blocked.d / 2 + 0.8;
    expect(insideX && insideZ).toBe(false);
  });

  it('still returns a finite spot when every side is blocked', () => {
    const c = car({ x: 0, z: 0, yaw: 0 });
    const wall = building('wall', 0, 0, 40, 40);
    const spot = exitPosition(c, [wall]);
    expect(Number.isFinite(spot.x)).toBe(true);
    expect(Number.isFinite(spot.z)).toBe(true);
  });

  it('handles a car with no yaw field', () => {
    expect(() => exitPosition({ x: 0, z: 0 }, [])).not.toThrow();
  });
});

describe('hashStr', () => {
  it('is stable and returns a uint32', () => {
    expect(hashStr('abc')).toBe(hashStr('abc'));
    expect(hashStr('abc')).not.toBe(hashStr('abd'));
    for (const s of ['', 'a', 'road-12:drive:4:-1']) {
      const h = hashStr(s);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });
});
