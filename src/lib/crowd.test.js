import { describe, it, expect } from 'vitest';
import { createCrowd, stepCrowd, agentPosition } from './crowd.js';

/** 3x3 grid of PathNodes, orthogonal neighbors only (no diagonals), 5u spacing. */
function gridPaths(spacing = 5) {
  const nodes = [];
  const idx = (r, c) => r * 3 + c;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      nodes.push({ x: c * spacing, z: r * spacing, links: [] });
    }
  }
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const links = [];
      if (c > 0) links.push(idx(r, c - 1));
      if (c < 2) links.push(idx(r, c + 1));
      if (r > 0) links.push(idx(r - 1, c));
      if (r < 2) links.push(idx(r + 1, c));
      nodes[idx(r, c)].links = links;
    }
  }
  return nodes;
}

/** Linear 3-node chain: 0 - 1 - 2 (node 0 and node 2 are dead ends). */
function chainPaths() {
  return [
    { x: 0, z: 0, links: [1] },
    { x: 2, z: 0, links: [0, 2] },
    { x: 4, z: 0, links: [1] },
  ];
}

function isAdjacent(crowd, a, b) {
  const { adjIndex, adjList } = crowd.graph;
  for (let k = adjIndex[a]; k < adjIndex[a + 1]; k++) {
    if (adjList[k] === b) return true;
  }
  return false;
}

function runSteps(crowd, paths, dt, steps) {
  for (let s = 0; s < steps; s++) stepCrowd(crowd, paths, dt);
}

describe('createCrowd', () => {
  it('produces no agents for an empty graph', () => {
    const crowd = createCrowd([], 50);
    expect(crowd.count).toBe(0);
  });

  it('produces no agents for a single isolated node (no links)', () => {
    const crowd = createCrowd([{ x: 0, z: 0, links: [] }], 50);
    expect(crowd.count).toBe(0);
  });

  it('produces no agents when links is missing entirely', () => {
    const crowd = createCrowd([{ x: 0, z: 0 }, { x: 1, z: 1 }], 50);
    expect(crowd.count).toBe(0);
  });

  it('ignores self-links and out-of-range link indices without crashing', () => {
    const paths = [
      { x: 0, z: 0, links: [0, 99, -1, 1.5, 1] },
      { x: 3, z: 0, links: [0] },
    ];
    expect(() => createCrowd(paths, 20)).not.toThrow();
    const crowd = createCrowd(paths, 20);
    expect(crowd.count).toBeGreaterThan(0);
    const out = { x: 0, z: 0, angle: 0 };
    for (let i = 0; i < crowd.count; i++) {
      agentPosition(crowd, i, out);
      expect(Number.isFinite(out.x)).toBe(true);
      expect(Number.isFinite(out.z)).toBe(true);
      expect(Number.isFinite(out.angle)).toBe(true);
    }
  });

  it('does not crash on a node with non-array links', () => {
    const paths = [
      { x: 0, z: 0, links: 'nope' },
      { x: 1, z: 1, links: [0] },
    ];
    expect(() => createCrowd(paths, 10)).not.toThrow();
  });

  it('scales agent count down for a small/sparse graph', () => {
    const crowd = createCrowd(chainPaths(), 120);
    expect(crowd.count).toBeGreaterThan(0);
    expect(crowd.count).toBeLessThan(120);
  });

  it('never exceeds the requested count', () => {
    const crowd = createCrowd(gridPaths(), 4);
    expect(crowd.count).toBeLessThanOrEqual(4);
  });

  it('assigns every agent a speed in the human walking range', () => {
    const crowd = createCrowd(gridPaths(), 50);
    for (let i = 0; i < crowd.count; i++) {
      expect(crowd.speed[i]).toBeGreaterThanOrEqual(1.2);
      expect(crowd.speed[i]).toBeLessThan(1.6);
    }
  });
});

describe('determinism', () => {
  it('identical seed/graph/steps produce identical positions', () => {
    const paths = gridPaths();
    const a = createCrowd(paths, 30);
    const b = createCrowd(paths, 30);
    runSteps(a, paths, 0.05, 200);
    runSteps(b, paths, 0.05, 200);
    expect(a.count).toBe(b.count);
    const outA = { x: 0, z: 0, angle: 0 };
    const outB = { x: 0, z: 0, angle: 0 };
    for (let i = 0; i < a.count; i++) {
      agentPosition(a, i, outA);
      agentPosition(b, i, outB);
      expect(outA.x).toBeCloseTo(outB.x, 10);
      expect(outA.z).toBeCloseTo(outB.z, 10);
      expect(outA.angle).toBeCloseTo(outB.angle, 10);
    }
  });

  it('is deterministic across many small variable-dt steps (no wall-clock dependence)', () => {
    const paths = gridPaths();
    const a = createCrowd(paths, 15);
    const b = createCrowd(paths, 15);
    for (let s = 0; s < 500; s++) {
      const dt = 0.01 + (s % 7) * 0.003; // varied but identical sequence for both
      stepCrowd(a, paths, dt);
      stepCrowd(b, paths, dt);
    }
    const outA = { x: 0, z: 0, angle: 0 };
    const outB = { x: 0, z: 0, angle: 0 };
    for (let i = 0; i < a.count; i++) {
      agentPosition(a, i, outA);
      agentPosition(b, i, outB);
      expect(outA.x).toBe(outB.x);
      expect(outA.z).toBe(outB.z);
    }
  });
});

describe('stepCrowd / agentPosition invariants', () => {
  it('every agent always lies on an edge between two linked nodes', () => {
    const paths = gridPaths();
    const crowd = createCrowd(paths, 40);
    for (let s = 0; s < 300; s++) {
      stepCrowd(crowd, paths, 0.033);
      for (let i = 0; i < crowd.count; i++) {
        const cur = crowd.curNode[i];
        const nxt = crowd.nextNode[i];
        expect(isAdjacent(crowd, cur, nxt)).toBe(true);
      }
    }
  });

  it('never produces NaN positions, including on degenerate graphs', () => {
    const graphs = [gridPaths(), chainPaths(), [], [{ x: 0, z: 0, links: [] }]];
    const out = { x: 0, z: 0, angle: 0 };
    for (const paths of graphs) {
      const crowd = createCrowd(paths, 60);
      for (let s = 0; s < 50; s++) stepCrowd(crowd, paths, 0.05);
      for (let i = 0; i < crowd.count; i++) {
        agentPosition(crowd, i, out);
        expect(Number.isFinite(out.x)).toBe(true);
        expect(Number.isFinite(out.z)).toBe(true);
        expect(Number.isFinite(out.angle)).toBe(true);
      }
    }
  });

  it('arrival advances curNode only to a node linked from the previous curNode', () => {
    const paths = gridPaths();
    const crowd = createCrowd(paths, 25);
    const prevCur = Int32Array.from(crowd.curNode);
    for (let s = 0; s < 400; s++) {
      stepCrowd(crowd, paths, 0.05);
      for (let i = 0; i < crowd.count; i++) {
        if (crowd.curNode[i] !== prevCur[i]) {
          expect(isAdjacent(crowd, prevCur[i], crowd.curNode[i])).toBe(true);
          prevCur[i] = crowd.curNode[i];
        }
      }
    }
  });

  it('reverses correctly at a dead-end node', () => {
    const paths = chainPaths(); // 0 - 1 - 2, node 2 is a dead end
    const crowd = createCrowd(paths, 1);
    // Force the single agent to be mid-edge, walking from node 1 to node 2.
    crowd.curNode[0] = 1;
    crowd.nextNode[0] = 2;
    crowd.prevNode[0] = 0;
    crowd.t[0] = 0.99;
    crowd.speed[0] = 1.2;
    stepCrowd(crowd, paths, 0.05); // enough to cross the remaining 0.01 * edgeLen
    expect(crowd.curNode[0]).toBe(2);
    expect(crowd.nextNode[0]).toBe(1); // only option at a dead end: reverse
  });

  it('clamps dt so a huge hitch cannot teleport an agent past an unlinked node', () => {
    const paths = chainPaths();
    const crowd = createCrowd(paths, 1);
    crowd.curNode[0] = 0;
    crowd.nextNode[0] = 1;
    crowd.prevNode[0] = -1;
    crowd.t[0] = 0;
    crowd.speed[0] = 1.2;
    stepCrowd(crowd, paths, 1e6); // absurd dt
    // Must land on a real node reachable from where it started, never NaN/out of range.
    expect(Number.isInteger(crowd.curNode[0])).toBe(true);
    expect(crowd.curNode[0]).toBeGreaterThanOrEqual(0);
    expect(crowd.curNode[0]).toBeLessThan(paths.length);
    expect(isAdjacent(crowd, 0, crowd.curNode[0]) || crowd.curNode[0] === 0).toBe(true);
    const out = { x: 0, z: 0, angle: 0 };
    agentPosition(crowd, 0, out);
    expect(Number.isFinite(out.x)).toBe(true);
    expect(Number.isFinite(out.z)).toBe(true);
    // A single stepCrowd call must not advance more than one edge hop.
    expect(crowd.curNode[0] === 0 || crowd.curNode[0] === 1).toBe(true);
  });

  it('handles a zero-length edge (coincident nodes) without NaN or infinite loops', () => {
    const paths = [
      { x: 5, z: 5, links: [1] },
      { x: 5, z: 5, links: [0] }, // same coordinates as node 0
    ];
    const crowd = createCrowd(paths, 5);
    expect(crowd.count).toBeGreaterThan(0);
    for (let s = 0; s < 20; s++) stepCrowd(crowd, paths, 0.05);
    const out = { x: 0, z: 0, angle: 0 };
    for (let i = 0; i < crowd.count; i++) {
      agentPosition(crowd, i, out);
      expect(Number.isFinite(out.x)).toBe(true);
      expect(Number.isFinite(out.z)).toBe(true);
    }
  });
});
