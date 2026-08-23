import { describe, it, expect, beforeEach } from 'vitest';
import { createChase, stepChase, chaseStats, assignTarget, drainEvents } from './chase.js';
import { playerState } from './playerState.js';

function resetInteraction() {
  playerState.targetedBug = null;
  playerState.deployRequested = false;
  playerState.uiFocused = false;
}

const BUILDINGS = [
  { id: 'src/a.js', x: 0, z: 0, w: 3, d: 3, height: 6 },
  { id: 'src/b.js', x: 20, z: 5, w: 4, d: 2, height: 10 },
  { id: 'src/c.js', x: -15, z: 30, w: 2, d: 2, height: 4 },
];

const HAZARDS = [
  { id: 'issue-1', path: 'src/a.js', kind: 'issue', severity: 8, title: 'Null deref', number: 1 },
  { id: 'issue-2', path: 'src/b.js', kind: 'issue', severity: 3, title: 'Lint warning', number: 2 },
  { id: 'risk-1', path: 'src/c.js', kind: 'risk', severity: 5, title: 'Untested path' },
  { id: 'pr-1', path: 'src/a.js', kind: 'pr', severity: 4, title: 'Fix null deref', number: 42 },
];

function stepN(state, n, dt) {
  for (let i = 0; i < n; i++) stepChase(state, dt);
}

function dist(ax, az, bx, bz) {
  return Math.hypot(ax - bx, az - bz);
}

/** The creature assignTarget most recently dispatched. */
function dispatched(state) {
  return state.greptileById.get(state.lastDispatchedId);
}

/** The (single, in these tests) creature currently hunting a given bug. */
function hunterOf(state, bugId) {
  return state.greptiles.find((g) => g.targetId === bugId) || null;
}

beforeEach(() => {
  resetInteraction();
});

describe('createChase', () => {
  it('builds one bug per issue/risk hazard and ignores pr hazards for bug spawning', () => {
    const state = createChase(HAZARDS, BUILDINGS);
    expect(state.bugs.length).toBe(3);
    expect(state.bugs.some((b) => b.id === 'pr-1')).toBe(false);
    expect(state.bugById.get('issue-1').buildingId).toBe('src/a.js');
  });

  it('accepts a buildings array or a pre-built buildingsById map equivalently', () => {
    const byId = {};
    for (const b of BUILDINGS) byId[b.id] = b;
    const s1 = createChase(HAZARDS, BUILDINGS);
    const s2 = createChase(HAZARDS, byId);
    expect(s1.bugs.length).toBe(s2.bugs.length);
    expect(s1.bugs.map((b) => b.id).sort()).toEqual(s2.bugs.map((b) => b.id).sort());
  });

  it('spawns a pack of several Greptiles, all idle, with no target', () => {
    const state = createChase(HAZARDS, BUILDINGS);
    expect(state.greptiles.length).toBe(4); // pack size — see report
    for (const g of state.greptiles) {
      expect(g.mode).toBe('idle');
      expect(g.targetId).toBeNull();
    }
    // ids are unique and stable
    const ids = state.greptiles.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('respects an explicit opts.packSize', () => {
    const state = createChase(HAZARDS, BUILDINGS, { packSize: 2 });
    expect(state.greptiles.length).toBe(2);
  });

  it('keeps state.greptile as a live alias for the primary (first) pack member', () => {
    const state = createChase(HAZARDS, BUILDINGS);
    expect(state.greptile).toBe(state.greptiles[0]);
    // mutating through the alias mutates the underlying creature
    state.greptile.x = 123;
    expect(state.greptiles[0].x).toBe(123);
  });
});

describe('determinism', () => {
  it('produces identical pack + bug state after N steps given the same input and dt sequence', () => {
    const s1 = createChase(HAZARDS, BUILDINGS);
    const s2 = createChase(HAZARDS, BUILDINGS);
    assignTarget(s1, 'issue-1');
    assignTarget(s2, 'issue-1');
    for (let i = 0; i < 250; i++) {
      const dt = 0.016 + (i % 3) * 0.004; // varied but identical for both runs
      stepChase(s1, dt);
      stepChase(s2, dt);
    }
    const snap = (s) => ({
      time: s.time,
      bugs: s.bugs.map((b) => ({ id: b.id, x: b.x, z: b.z, state: b.state, deathT: b.deathT, seed: b.seed })),
      greptiles: s.greptiles.map((g) => ({
        id: g.id, x: g.x, z: g.z, mode: g.mode, targetId: g.targetId, catches: g.catches, seed: g.seed,
      })),
    });
    expect(snap(s1)).toEqual(snap(s2));
  });

  it('spawns the pack at deterministic, distinct starting positions', () => {
    const s1 = createChase(HAZARDS, BUILDINGS);
    const s2 = createChase(HAZARDS, BUILDINGS);
    expect(s1.greptiles.map((g) => [g.x, g.z])).toEqual(s2.greptiles.map((g) => [g.x, g.z]));
    // not all identical (they're actually spread out, not stacked at one point)
    const distinctX = new Set(s1.greptiles.map((g) => g.x.toFixed(3)));
    expect(distinctX.size).toBeGreaterThan(1);
  });
});

describe('bug wander', () => {
  it('keeps bugs near their anchor building throughout the simulation', () => {
    const state = createChase(HAZARDS, BUILDINGS);
    for (let i = 0; i < 600; i++) {
      stepChase(state, 0.05);
      for (const b of state.bugs) {
        if (b.state !== 'alive') continue;
        expect(dist(b.x, b.z, b.ax, b.az)).toBeLessThanOrEqual(b.anchorRadius * 1.6 + 1e-6);
      }
    }
  });
});

describe('pack roaming', () => {
  it('roams each idle creature independently — their paths diverge over time', () => {
    const state = createChase(HAZARDS, BUILDINGS);
    stepN(state, 400, 0.05); // ~20s of idle roaming, nobody assigned
    const positions = state.greptiles.map((g) => `${g.x.toFixed(2)}:${g.z.toFixed(2)}`);
    expect(new Set(positions).size).toBe(state.greptiles.length); // no two coincide
    for (const g of state.greptiles) {
      expect(g.mode).toBe('idle'); // nobody was ever assigned
      expect(Number.isFinite(g.x)).toBe(true);
      expect(Number.isFinite(g.z)).toBe(true);
    }
  });
});

describe('nearest-idle dispatch', () => {
  it('dispatches the nearest idle creature to the target bug', () => {
    const state = createChase(HAZARDS, BUILDINGS, { packSize: 3 });
    const bug = state.bugById.get('issue-1');
    // Place creatures at known, controlled distances from the bug.
    state.greptiles[0].x = bug.x + 100; state.greptiles[0].z = bug.z + 100;
    state.greptiles[1].x = bug.x + 5; state.greptiles[1].z = bug.z + 5; // closest
    state.greptiles[2].x = bug.x - 50; state.greptiles[2].z = bug.z - 50;

    const result = assignTarget(state, 'issue-1');
    expect(result).toBe('ok');
    expect(state.greptiles[1].targetId).toBe('issue-1');
    expect(state.greptiles[1].mode).toBe('hunt');
    expect(state.greptiles[0].targetId).toBeNull();
    expect(state.greptiles[2].targetId).toBeNull();
    expect(state.lastDispatchedId).toBe(state.greptiles[1].id);
  });

  it('does not double-dispatch a bug that is already being hunted', () => {
    const state = createChase(HAZARDS, BUILDINGS);
    assignTarget(state, 'issue-1');
    const first = hunterOf(state, 'issue-1');
    expect(first).not.toBeNull();

    stepN(state, 5, 0.05); // still in flight, not yet captured
    const result = assignTarget(state, 'issue-1'); // press E again on the same bug
    expect(result).toBe('ok');
    const hunters = state.greptiles.filter((g) => g.targetId === 'issue-1');
    expect(hunters.length).toBe(1);
    expect(hunters[0].id).toBe(first.id);
  });

  it('assigning a different bug while one creature is mid-hunt dispatches another idle one, leaving the first uninterrupted', () => {
    const state = createChase(HAZARDS, BUILDINGS);
    assignTarget(state, 'issue-1');
    const first = hunterOf(state, 'issue-1');
    stepN(state, 5, 0.05);

    assignTarget(state, 'issue-2');
    const second = hunterOf(state, 'issue-2');
    expect(second).not.toBeNull();
    expect(second.id).not.toBe(first.id); // a different, idle creature took it

    // the first hunt is untouched
    expect(state.greptileById.get(first.id).targetId).toBe('issue-1');
    expect(state.bugById.get('issue-1').state).toBe('alive');
  });

  it('preempts the nearest busy creature once the whole pack is occupied', () => {
    const state = createChase(HAZARDS, BUILDINGS, { packSize: 2 });
    assignTarget(state, 'issue-1');
    assignTarget(state, 'issue-2');
    // both creatures are now busy
    expect(state.greptiles.every((g) => g.mode !== 'idle')).toBe(true);

    const result = assignTarget(state, 'risk-1'); // a deploy press should never be a no-op
    expect(result).toBe('ok');
    const hunter = hunterOf(state, 'risk-1');
    expect(hunter).not.toBeNull(); // someone was preempted onto it
  });

  it('rejects invalid, unknown, and dead bug ids', () => {
    const state = createChase(HAZARDS, BUILDINGS);
    expect(assignTarget(state, null)).toBe('invalid');
    expect(assignTarget(state, undefined)).toBe('invalid');
    expect(assignTarget(state, 'does-not-exist')).toBe('not-found');

    const bug = state.bugById.get('issue-2');
    bug.state = 'dead';
    expect(assignTarget(state, 'issue-2')).toBe('dead');
  });
});

describe('greptile pursuit', () => {
  it('the dispatched creature converges on its target: distance strictly decreases over enough steps', () => {
    const state = createChase(HAZARDS, BUILDINGS);
    assignTarget(state, 'issue-1');
    const hunter = dispatched(state);
    // Start it far from every bug so wander jitter is negligible next to the
    // ground it has to cover.
    hunter.x = -500;
    hunter.z = -500;
    const target = state.bugById.get('issue-1');

    const checkpoints = [];
    for (let i = 0; i < 40; i++) {
      stepN(state, 20, 0.05); // 20 steps = 1s per checkpoint
      checkpoints.push(dist(hunter.x, hunter.z, target.x, target.z));
      if (target.state !== 'alive') break; // captured before all checkpoints ran
    }
    expect(checkpoints.length).toBeGreaterThan(1);
    for (let i = 1; i < checkpoints.length; i++) {
      expect(checkpoints[i]).toBeLessThanOrEqual(checkpoints[i - 1] + 0.05);
    }
    expect(checkpoints[checkpoints.length - 1]).toBeLessThan(checkpoints[0]);
  });

  it('captures within the capture radius, is not auto-retargeted, and reports it via events', () => {
    const state = createChase(HAZARDS, BUILDINGS);
    assignTarget(state, 'issue-2'); // low severity, but explicit assignment
    const hunter = dispatched(state);
    const bug = state.bugById.get('issue-2');

    let caught = false;
    for (let i = 0; i < 4000 && !caught; i++) {
      stepChase(state, 0.03);
      if (bug.state !== 'alive') caught = true;
    }
    expect(caught).toBe(true);
    expect(bug.state === 'dying' || bug.state === 'dead').toBe(true);
    expect(hunter.catches).toBe(1);
    expect(chaseStats(state).bugsCaught).toBe(1);

    // let the dying beat finish
    stepN(state, 40, 0.05);
    expect(bug.state).toBe('dead');
    // no auto-retarget after a kill
    expect(hunter.targetId).toBeNull();
    expect(hunter.mode).toBe('idle');

    const events = drainEvents(state);
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ type: 'kill', bugId: 'issue-2', prNumber: null, greptileId: hunter.id });
    // draining again with nothing new returns an empty array without growing state.events
    expect(drainEvents(state).length).toBe(0);
  });

  it('attaches the matching PR number to the kill event when one targets the same building', () => {
    const state = createChase(HAZARDS, BUILDINGS);
    assignTarget(state, 'issue-1'); // src/a.js also has pr-1 (#42)
    const bug = state.bugById.get('issue-1');
    for (let i = 0; i < 5000 && bug.state === 'alive'; i++) stepChase(state, 0.03);
    const events = drainEvents(state);
    expect(events.length).toBe(1);
    expect(events[0].prNumber).toBe(42);
  });
});

describe('playerState-driven deploy', () => {
  it('consumes playerState.deployRequested + targetedBug and resets the flag', () => {
    const state = createChase(HAZARDS, BUILDINGS);
    playerState.targetedBug = 'issue-1';
    playerState.deployRequested = true;
    stepChase(state, 0.016);
    expect(playerState.deployRequested).toBe(false);
    const hunter = hunterOf(state, 'issue-1');
    expect(hunter).not.toBeNull();
    expect(hunter.mode).toBe('hunt');
  });

  it('ignores a deploy request with no targetedBug and does not throw on an invalid one', () => {
    const state = createChase(HAZARDS, BUILDINGS);
    playerState.targetedBug = null;
    playerState.deployRequested = true;
    expect(() => stepChase(state, 0.016)).not.toThrow();
    expect(playerState.deployRequested).toBe(false);
    expect(state.greptiles.every((g) => g.mode === 'idle')).toBe(true);

    playerState.targetedBug = 'nonexistent';
    playerState.deployRequested = true;
    expect(() => stepChase(state, 0.016)).not.toThrow();
    expect(state.greptiles.every((g) => g.mode === 'idle')).toBe(true);
  });
});

describe('all-bugs-dead end state', () => {
  it('keeps running with no crash/NaN once every bug has been permanently killed', () => {
    const state = createChase(HAZARDS, BUILDINGS);
    for (const b of state.bugs) {
      assignTarget(state, b.id);
      for (let i = 0; i < 5000 && b.state === 'alive'; i++) stepChase(state, 0.03);
    }
    stepN(state, 60, 0.05); // let death beats finish

    const stats = chaseStats(state);
    expect(stats.bugsAlive).toBe(0);
    expect(stats.bugsCaught).toBe(state.bugs.length);

    const before = state.greptiles.map((g) => ({ x: g.x, z: g.z }));
    stepN(state, 200, 0.05); // no auto-respawn: should just idle-roam, never crash
    for (const g of state.greptiles) {
      expect(g.mode).toBe('idle');
      expect(Number.isFinite(g.x)).toBe(true);
      expect(Number.isFinite(g.z)).toBe(true);
    }
    // the pack is still "alive and present": roaming actually moves them over 10s
    const moved = state.greptiles.some((g, i) => dist(before[i].x, before[i].z, g.x, g.z) > 0);
    expect(moved).toBe(true);

    for (const b of state.bugs) {
      expect(Number.isFinite(b.x)).toBe(true);
      expect(Number.isFinite(b.z)).toBe(true);
    }
  });
});

describe('dt clamping', () => {
  it('clamps a huge dt so nothing teleports on a tab-switch hitch', () => {
    const state = createChase(HAZARDS, BUILDINGS);
    assignTarget(state, 'issue-1');
    const hunter = dispatched(state);
    hunter.x = -1000;
    hunter.z = -1000;
    stepChase(state, 999); // one enormous frame
    // With dt clamped to ~0.1s and a top speed well under 30u/s, this can't
    // have travelled anywhere near the ~1400 units to the target in one step.
    expect(dist(-1000, -1000, hunter.x, hunter.z)).toBeLessThan(10);
    expect(Number.isFinite(hunter.x)).toBe(true);
    expect(Number.isFinite(hunter.z)).toBe(true);
  });

  it('handles negative/NaN/undefined dt without crashing or producing NaN', () => {
    const state = createChase(HAZARDS, BUILDINGS);
    assignTarget(state, 'issue-1');
    expect(() => stepChase(state, -5)).not.toThrow();
    expect(() => stepChase(state, NaN)).not.toThrow();
    expect(() => stepChase(state, undefined)).not.toThrow();
    for (const g of state.greptiles) {
      expect(Number.isFinite(g.x)).toBe(true);
      expect(Number.isFinite(g.z)).toBe(true);
    }
  });
});

describe('uiFocused softening', () => {
  it('advances the sim much more slowly while a panel has focus, but still advances', () => {
    const stateA = createChase(HAZARDS, BUILDINGS);
    const stateB = createChase(HAZARDS, BUILDINGS);
    assignTarget(stateA, 'issue-1');
    assignTarget(stateB, 'issue-1');
    const hunterA = dispatched(stateA);
    const hunterB = dispatched(stateB);
    hunterA.x = hunterB.x = -200;
    hunterA.z = hunterB.z = -200;

    playerState.uiFocused = false;
    stepN(stateA, 30, 0.05);
    playerState.uiFocused = true;
    stepN(stateB, 30, 0.05);
    playerState.uiFocused = false;

    const targetA = stateA.bugById.get('issue-1');
    const targetB = stateB.bugById.get('issue-1');
    const dA = dist(hunterA.x, hunterA.z, targetA.x, targetA.z);
    const dB = dist(hunterB.x, hunterB.z, targetB.x, targetB.z);
    // both moved toward the target, but the ui-focused run covered less ground
    expect(dA).toBeLessThan(1200); // sanity: it moved from -200,-200 at all
    expect(dB).toBeGreaterThan(dA);
  });
});

describe('degenerate inputs', () => {
  it('handles no hazards at all', () => {
    const state = createChase([], BUILDINGS);
    expect(state.bugs.length).toBe(0);
    // the pack still idle-roams even with nothing to hunt
    expect(() => stepChase(state, 0.016)).not.toThrow();
    const stats = chaseStats(state);
    expect(stats.bugsAlive).toBe(0);
    expect(stats.bugsCaught).toBe(0);
    expect(stats.targetId).toBeNull();
    expect(Number.isFinite(stats.greptilePos.x)).toBe(true);
    expect(Number.isFinite(stats.greptilePos.z)).toBe(true);
    expect(stats.greptiles.length).toBe(state.greptiles.length);
  });

  it('drops hazards whose path is missing from buildings', () => {
    const hazards = [
      { id: 'issue-x', path: 'does/not/exist.js', kind: 'issue', severity: 5, title: 'ghost' },
    ];
    const state = createChase(hazards, BUILDINGS);
    expect(state.bugs.length).toBe(0);
    expect(() => stepChase(state, 0.016)).not.toThrow();
  });

  it('works with a single hazard', () => {
    const hazards = [{ id: 'issue-only', path: 'src/a.js', kind: 'issue', severity: 5, title: 'lonely bug' }];
    const state = createChase(hazards, BUILDINGS);
    expect(state.bugs.length).toBe(1);
    assignTarget(state, 'issue-only');
    expect(() => stepN(state, 100, 0.03)).not.toThrow();
  });

  it('tolerates missing/null/undefined buildings and hazards without crashing', () => {
    expect(() => createChase(null, null)).not.toThrow();
    expect(() => createChase(undefined, undefined)).not.toThrow();
    const state = createChase(null, null);
    expect(state.bugs.length).toBe(0);
    expect(() => stepChase(state, 0.016)).not.toThrow();
    for (const g of state.greptiles) {
      expect(Number.isFinite(g.x)).toBe(true);
      expect(Number.isFinite(g.z)).toBe(true);
    }
  });

  it('treats a non-positive opts.packSize as "unset" and falls back to the default pack size', () => {
    const state = createChase(HAZARDS, BUILDINGS, { packSize: 0 });
    expect(state.greptiles.length).toBeGreaterThan(0);
  });

  it('handles assignTarget/chaseStats gracefully with a degenerate (empty) pack', () => {
    const state = createChase(HAZARDS, BUILDINGS);
    state.greptiles.length = 0; // simulate a pack that's been emptied out
    state.greptileById.clear();
    expect(assignTarget(state, 'issue-1')).toBe('invalid');
    expect(() => stepChase(state, 0.016)).not.toThrow();
    const stats = chaseStats(state);
    expect(stats.bugsCaught).toBe(0);
    expect(stats.greptiles).toEqual([]);
  });

  it('never produces NaN positions across a long run with mixed dt', () => {
    const state = createChase(HAZARDS, BUILDINGS);
    assignTarget(state, 'risk-1');
    for (let i = 0; i < 500; i++) {
      stepChase(state, i % 7 === 0 ? 0 : 0.016);
      for (const g of state.greptiles) {
        expect(Number.isFinite(g.x)).toBe(true);
        expect(Number.isFinite(g.z)).toBe(true);
      }
      for (const b of state.bugs) {
        expect(Number.isFinite(b.x)).toBe(true);
        expect(Number.isFinite(b.z)).toBe(true);
      }
    }
  });
});
