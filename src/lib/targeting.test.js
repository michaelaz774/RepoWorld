import { describe, it, expect } from 'vitest';
import { pickTarget, angularOffset, isInFront } from './targeting.js';

/** Camera at the origin looking down -Z (the codebase's default heading). */
const CAM = { x: 0, y: 0, z: 0, dirX: 0, dirY: 0, dirZ: -1 };

describe('pickTarget', () => {
  it('picks the candidate nearest the crosshair by angle, not merely nearest by distance', () => {
    // A: dead ahead, angle 0, but far away (30u).
    const a = { id: 'a', x: 0, y: 0, z: -30, radius: 0.5 };
    // B: much closer in raw distance (~12u) but off-axis by ~8 degrees — still
    // inside the default 12-degree cone.
    const angleB = 8 * (Math.PI / 180);
    const distB = 12;
    const b = {
      id: 'b',
      x: Math.sin(angleB) * distB,
      y: 0,
      z: -Math.cos(angleB) * distB,
      radius: 0.5,
    };
    expect(pickTarget(CAM, [a, b])).toBe('a');
    expect(pickTarget(CAM, [b, a])).toBe('a'); // order-independent
  });

  it('rejects candidates behind the camera', () => {
    const behind = { id: 'behind', x: 0, y: 0, z: 10 }; // +Z is behind a -Z-facing camera
    expect(pickTarget(CAM, [behind])).toBeNull();
  });

  it('rejects a candidate exactly at the cone edge boundary but accepts just inside it', () => {
    const coneDegrees = 10;
    const justInside = 9.9 * (Math.PI / 180);
    const justOutside = 10.1 * (Math.PI / 180);
    const dist = 20;
    const inCone = {
      id: 'in',
      x: Math.sin(justInside) * dist,
      y: 0,
      z: -Math.cos(justInside) * dist,
    };
    const outCone = {
      id: 'out',
      x: Math.sin(justOutside) * dist,
      y: 0,
      z: -Math.cos(justOutside) * dist,
    };
    expect(pickTarget(CAM, [inCone], { coneDegrees })).toBe('in');
    expect(pickTarget(CAM, [outCone], { coneDegrees })).toBeNull();
  });

  it('respects maxDistance', () => {
    const far = { id: 'far', x: 0, y: 0, z: -70 }; // beyond default 60u
    expect(pickTarget(CAM, [far])).toBeNull();
    expect(pickTarget(CAM, [far], { maxDistance: 100 })).toBe('far');
  });

  it('returns null when there are no candidates', () => {
    expect(pickTarget(CAM, [])).toBeNull();
    expect(pickTarget(CAM, null)).toBeNull();
    expect(pickTarget(CAM, undefined)).toBeNull();
  });

  it('returns null when no candidate falls inside the cone', () => {
    const wide = { id: 'wide', x: 0, y: 0, z: 10 }; // behind
    const offAxis = { id: 'off', x: 50, y: 0, z: -1 }; // ~90 degrees off-axis
    expect(pickTarget(CAM, [wide, offAxis])).toBeNull();
  });

  it('breaks ties deterministically by distance, then by id', () => {
    // Same angle (dead ahead), same distance, different ids: 'apple' should
    // win over 'banana' by string comparison, regardless of array order.
    const apple = { id: 'apple', x: 0, y: 0, z: -10 };
    const banana = { id: 'banana', x: 0, y: 0, z: -10 };
    expect(pickTarget(CAM, [apple, banana])).toBe('apple');
    expect(pickTarget(CAM, [banana, apple])).toBe('apple');

    // Same angle, different distance: the nearer one wins even though it
    // sorts later alphabetically.
    const near = { id: 'zzz-near', x: 0, y: 0, z: -5 };
    const far = { id: 'aaa-far', x: 0, y: 0, z: -20 };
    expect(pickTarget(CAM, [near, far])).toBe('zzz-near');
  });

  it('handles a zero-length view direction without throwing or returning NaN', () => {
    const degenerateCam = { x: 0, y: 0, z: 0, dirX: 0, dirY: 0, dirZ: 0 };
    const ahead = { id: 'ahead', x: 0, y: 0, z: -10 }; // matches the -Z fallback heading
    let result;
    expect(() => { result = pickTarget(degenerateCam, [ahead]); }).not.toThrow();
    expect(result).toBe('ahead');
    expect(Number.isNaN(result)).toBe(false);
  });

  it('handles a candidate exactly at the camera position without throwing or returning NaN', () => {
    const atCamera = { id: 'same-spot', x: 0, y: 0, z: 0 };
    const normal = { id: 'normal', x: 0, y: 0, z: -20 };
    let result;
    expect(() => { result = pickTarget(CAM, [atCamera, normal]); }).not.toThrow();
    // The coincident candidate has angle 0 by definition and wins.
    expect(result).toBe('same-spot');
  });

  it('handles NaN coordinates on candidates by skipping them, not throwing or propagating NaN', () => {
    const nanCandidate = { id: 'nan', x: NaN, y: 0, z: -10 };
    const valid = { id: 'valid', x: 0, y: 0, z: -10 };
    let result;
    expect(() => { result = pickTarget(CAM, [nanCandidate, valid]); }).not.toThrow();
    expect(result).toBe('valid');
  });

  it('handles NaN coordinates on the camera by returning null, not throwing', () => {
    const badCam = { x: NaN, y: 0, z: 0, dirX: 0, dirY: 0, dirZ: -1 };
    const candidate = { id: 'x', x: 0, y: 0, z: -10 };
    let result;
    expect(() => { result = badCam && pickTarget(badCam, [candidate]); }).not.toThrow();
    expect(result).toBeNull();
  });

  it('skips falsy/malformed entries in the candidate array', () => {
    const valid = { id: 'valid', x: 0, y: 0, z: -10 };
    expect(pickTarget(CAM, [null, undefined, {}, valid])).toBe('valid');
  });
});

describe('angularOffset', () => {
  it('is 0 for a point dead ahead', () => {
    expect(angularOffset(CAM, { x: 0, y: 0, z: -10 })).toBeCloseTo(0, 6);
  });

  it('is pi for a point directly behind', () => {
    expect(angularOffset(CAM, { x: 0, y: 0, z: 10 })).toBeCloseTo(Math.PI, 6);
  });

  it('is pi/2 for a point directly to the side', () => {
    expect(angularOffset(CAM, { x: 10, y: 0, z: 0 })).toBeCloseTo(Math.PI / 2, 6);
  });

  it('does not throw or return NaN for a zero-length view direction', () => {
    const degenerateCam = { x: 0, y: 0, z: 0, dirX: 0, dirY: 0, dirZ: 0 };
    let result;
    expect(() => { result = angularOffset(degenerateCam, { x: 0, y: 0, z: -5 }); }).not.toThrow();
    expect(Number.isNaN(result)).toBe(false);
  });

  it('does not throw or return NaN for a point at the camera position', () => {
    let result;
    expect(() => { result = angularOffset(CAM, { x: 0, y: 0, z: 0 }); }).not.toThrow();
    expect(result).toBe(0);
  });

  it('does not throw or return NaN for NaN coordinates', () => {
    let result;
    expect(() => { result = angularOffset(CAM, { x: NaN, y: 0, z: -10 }); }).not.toThrow();
    expect(Number.isNaN(result)).toBe(false);
  });
});

describe('isInFront', () => {
  it('is true for a point ahead and false for a point behind', () => {
    expect(isInFront(CAM, { x: 0, y: 0, z: -10 })).toBe(true);
    expect(isInFront(CAM, { x: 0, y: 0, z: 10 })).toBe(false);
  });

  it('does not throw for degenerate input', () => {
    const degenerateCam = { x: 0, y: 0, z: 0, dirX: 0, dirY: 0, dirZ: 0 };
    expect(() => isInFront(degenerateCam, { x: 0, y: 0, z: -5 })).not.toThrow();
    expect(() => isInFront(CAM, { x: 0, y: 0, z: 0 })).not.toThrow();
    expect(() => isInFront(CAM, { x: NaN, y: 0, z: 0 })).not.toThrow();
    expect(isInFront(CAM, { x: NaN, y: 0, z: 0 })).toBe(false);
  });
});

describe('beam-column targeting (aim at the beacon, not just the bug)', () => {
  // Camera at eye height, looking straight down -Z at a bug 40 units away.
  const camAt = (pitchY) => ({ x: 0, y: 2, z: 0, dirX: 0, dirY: pitchY, dirZ: -1 });
  const bug = { id: 'bug-1', x: 0, y: 0, z: -40, beamHeight: 46 };
  const opts = { maxDistance: 140, coneDegrees: 5 };

  it('hits the bug when aiming level at it', () => {
    expect(pickTarget(camAt(0), [bug], opts)).toBe('bug-1');
  });

  it('hits when the crosshair is up on the beam, far above the bug itself', () => {
    // Looking up ~28 degrees: nowhere near the bug on the ground, but squarely on the
    // beacon column rising above it.
    const cam = { x: 0, y: 2, z: 0, dirX: 0, dirY: 0.53, dirZ: -1 };
    expect(pickTarget(cam, [bug], opts)).toBe('bug-1');
  });

  it('misses when aiming well off to the side of both bug and beam', () => {
    const cam = { x: 0, y: 2, z: 0, dirX: 0.6, dirY: 0, dirZ: -1 };
    expect(pickTarget(cam, [bug], opts)).toBeNull();
  });

  it('misses when aiming above the top of the beam', () => {
    // Straight up — past the beam's 46-unit ceiling.
    const cam = { x: 0, y: 2, z: 0, dirX: 0, dirY: 6, dirZ: -1 };
    expect(pickTarget(cam, [bug], opts)).toBeNull();
  });

  it('a bug with no beamHeight still behaves as a plain point target', () => {
    const flat = { id: 'flat', x: 0, y: 0, z: -40 };
    expect(pickTarget(camAt(0), [flat], opts)).toBe('flat');
    const cam = { x: 0, y: 2, z: 0, dirX: 0, dirY: 0.53, dirZ: -1 };
    expect(pickTarget(cam, [flat], opts)).toBeNull();
  });

  it('prefers the candidate the crosshair is actually closest to', () => {
    const near = { id: 'near', x: 0, y: 0, z: -30, beamHeight: 46 };
    const offAxis = { id: 'off', x: 2, y: 0, z: -20, beamHeight: 46 };
    expect(pickTarget(camAt(0), [offAxis, near], opts)).toBe('near');
  });
});
