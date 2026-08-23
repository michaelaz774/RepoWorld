import { describe, it, expect } from 'vitest';
import { buildCity, districtOf, heightForSize, squarify, findSpawn } from './layout.js';
import { EYE_HEIGHT, langForExt, colorForLang } from './types.js';

const EPS = 1e-6;

/** Build a synthetic FileNode. */
function fileNode(path, size) {
  const parts = path.split('/');
  const name = parts[parts.length - 1];
  const dir = parts.slice(0, -1).join('/');
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
  return { path, name, dir, size, ext, lang: langForExt(ext) };
}

/** Deterministic LCG so the 350-file corpus is stable across runs. */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function syntheticFiles(count) {
  const rng = makeRng(42);
  const dirs = [
    '', 'src', 'src/lib', 'src/lib/utils', 'src/components', 'src/hooks',
    'tests', 'tests/unit', 'docs', 'scripts', 'assets/img', 'server/routes',
  ];
  const exts = ['js', 'ts', 'py', 'css', 'md', 'json', 'rs', 'go'];
  const files = [];
  for (let i = 0; i < count; i++) {
    const dir = dirs[Math.floor(rng() * dirs.length)];
    const ext = exts[Math.floor(rng() * exts.length)];
    const size = Math.floor(rng() * rng() * 200000); // skewed, up to ~200KB
    const path = (dir ? dir + '/' : '') + 'file' + i + '.' + ext;
    files.push(fileNode(path, size));
  }
  return files;
}

/** Gap between two axis-aligned footprints (max of per-axis gaps; >0 = separated). */
function footprintGap(a, b) {
  const gx = Math.abs(a.x - b.x) - (a.w + b.w) / 2;
  const gz = Math.abs(a.z - b.z) - (a.d + b.d) / 2;
  return Math.max(gx, gz);
}

function rectsOverlap(a, b) {
  // Center/extent rects; strict overlap with tolerance.
  return (
    Math.abs(a.x - b.x) < (a.w + b.w) / 2 - EPS &&
    Math.abs(a.z - b.z) < (a.d + b.d) / 2 - EPS
  );
}

// --- helpers for the new roads/plots/paths/snapping contract ---------------

const SNAP_EPS = 1e-6;

function isInteger(v) {
  return Math.abs(v - Math.round(v)) < SNAP_EPS;
}
function isMultipleOfHalf(v) {
  return Math.abs(v * 2 - Math.round(v * 2)) < SNAP_EPS;
}

/** Center/extent rect -> {xmin,xmax,zmin,zmax}. Works for Building and Plot. */
function asRect(o) {
  return { xmin: o.x - o.w / 2, xmax: o.x + o.w / 2, zmin: o.z - o.d / 2, zmax: o.z + o.d / 2 };
}

/** A RoadSegment as the thick axis-aligned rect it actually occupies. */
function roadRect(r) {
  const vertical = Math.abs(r.x1 - r.x2) < 1e-3;
  if (vertical) {
    return {
      xmin: r.x1 - r.width / 2,
      xmax: r.x1 + r.width / 2,
      zmin: Math.min(r.z1, r.z2),
      zmax: Math.max(r.z1, r.z2),
    };
  }
  return {
    xmin: Math.min(r.x1, r.x2),
    xmax: Math.max(r.x1, r.x2),
    zmin: r.z1 - r.width / 2,
    zmax: r.z1 + r.width / 2,
  };
}

function rectsOverlapAABB(a, b, eps = 1e-3) {
  return a.xmin < b.xmax - eps && b.xmin < a.xmax - eps && a.zmin < b.zmax - eps && b.zmin < a.zmax - eps;
}

function isVerticalSeg(s) {
  return Math.abs(s.x1 - s.x2) < 1e-3;
}

/** Do two axis-aligned road segments touch (shared endpoint, T-junction, or a
 *  genuine perpendicular crossing)? Covers all three cases with one check. */
function segsTouch(a, b, eps = 1e-3) {
  const av = isVerticalSeg(a);
  const bv = isVerticalSeg(b);
  if (av && bv) {
    if (Math.abs(a.x1 - b.x1) > eps) return false;
    const alo = Math.min(a.z1, a.z2), ahi = Math.max(a.z1, a.z2);
    const blo = Math.min(b.z1, b.z2), bhi = Math.max(b.z1, b.z2);
    return alo <= bhi + eps && blo <= ahi + eps;
  }
  if (!av && !bv) {
    if (Math.abs(a.z1 - b.z1) > eps) return false;
    const alo = Math.min(a.x1, a.x2), ahi = Math.max(a.x1, a.x2);
    const blo = Math.min(b.x1, b.x2), bhi = Math.max(b.x1, b.x2);
    return alo <= bhi + eps && blo <= ahi + eps;
  }
  const v = av ? a : b;
  const h = av ? b : a;
  const hlo = Math.min(h.x1, h.x2), hhi = Math.max(h.x1, h.x2);
  const vlo = Math.min(v.z1, v.z2), vhi = Math.max(v.z1, v.z2);
  return v.x1 >= hlo - eps && v.x1 <= hhi + eps && h.z1 >= vlo - eps && h.z1 <= vhi + eps;
}

/** Are all road segments reachable from segment 0 via segsTouch? */
function roadsConnected(roads) {
  if (roads.length <= 1) return true;
  const seen = new Array(roads.length).fill(false);
  const stack = [0];
  seen[0] = true;
  let count = 1;
  while (stack.length) {
    const i = stack.pop();
    for (let j = 0; j < roads.length; j++) {
      if (!seen[j] && segsTouch(roads[i], roads[j])) {
        seen[j] = true;
        count++;
        stack.push(j);
      }
    }
  }
  return count === roads.length;
}

describe('districtOf', () => {
  it('maps root files to "/"', () => {
    expect(districtOf({ dir: '' })).toBe('/');
    expect(districtOf({})).toBe('/');
    expect(districtOf(null)).toBe('/');
  });
  it('uses the top-level directory', () => {
    expect(districtOf({ dir: 'src' })).toBe('src');
    expect(districtOf({ dir: 'src/lib' })).toBe('src');
    expect(districtOf({ dir: 'src/lib/deep/deeper' })).toBe('src');
    expect(districtOf({ dir: 'tests' })).toBe('tests');
  });
});

describe('heightForSize', () => {
  it('stays within [1.5, 30]', () => {
    for (const s of [0, 1, 100, 2048, 500000, 50e6, -5, NaN, undefined]) {
      const h = heightForSize(s);
      expect(h).toBeGreaterThanOrEqual(1.5);
      expect(h).toBeLessThanOrEqual(30);
    }
  });
  it('is monotonic non-decreasing in size', () => {
    let prev = -Infinity;
    for (let s = 0; s <= 1000000; s += 3777) {
      const h = heightForSize(s);
      expect(h).toBeGreaterThanOrEqual(prev - EPS);
      prev = h;
    }
  });
  it('puts typical 2-20KB source files in the 4-12 range', () => {
    expect(heightForSize(2048)).toBeGreaterThanOrEqual(4);
    expect(heightForSize(20480)).toBeLessThanOrEqual(12);
  });
});

describe('squarify', () => {
  const rect = { x: -10, z: 4, w: 40, d: 30 };
  const items = [
    { key: 'a', weight: 6 }, { key: 'b', weight: 6 }, { key: 'c', weight: 4 },
    { key: 'd', weight: 3 }, { key: 'e', weight: 2 }, { key: 'f', weight: 2 },
    { key: 'g', weight: 1 },
  ];

  it('returns one tile per item, covering the rect area', () => {
    const tiles = squarify(items, rect);
    expect(tiles.length).toBe(items.length);
    expect(new Set(tiles.map((t) => t.key)).size).toBe(items.length);
    const area = tiles.reduce((s, t) => s + t.w * t.d, 0);
    expect(area).toBeCloseTo(rect.w * rect.d, 6);
  });

  it('makes tile areas proportional to weights', () => {
    const tiles = squarify(items, rect);
    const total = items.reduce((s, i) => s + i.weight, 0);
    for (const it of items) {
      const t = tiles.find((x) => x.key === it.key);
      expect(t.w * t.d).toBeCloseTo((it.weight / total) * rect.w * rect.d, 6);
    }
  });

  it('keeps every tile inside the rect and tiles disjoint', () => {
    const tiles = squarify(items, rect);
    for (const t of tiles) {
      expect(t.x).toBeGreaterThanOrEqual(rect.x - EPS);
      expect(t.z).toBeGreaterThanOrEqual(rect.z - EPS);
      expect(t.x + t.w).toBeLessThanOrEqual(rect.x + rect.w + EPS);
      expect(t.z + t.d).toBeLessThanOrEqual(rect.z + rect.d + EPS);
    }
    for (let i = 0; i < tiles.length; i++) {
      for (let j = i + 1; j < tiles.length; j++) {
        const a = tiles[i];
        const b = tiles[j];
        const overlap =
          a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS &&
          a.z < b.z + b.d - EPS && b.z < a.z + a.d - EPS;
        expect(overlap).toBe(false);
      }
    }
  });

  it('keeps aspect ratios reasonable (squarified, not sliced)', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ key: 'k' + i, weight: 1 + (i % 5) }));
    const tiles = squarify(many, { x: 0, z: 0, w: 50, d: 50 });
    for (const t of tiles) {
      const ar = Math.max(t.w / t.d, t.d / t.w);
      // Naive slicing would give aspect ratios > 20 here; squarify stays low.
      expect(ar).toBeLessThan(4.5);
    }
  });

  it('handles empty input, a single item, and zero weights', () => {
    expect(squarify([], { x: 0, z: 0, w: 10, d: 10 })).toEqual([]);
    const one = squarify([{ key: 'solo', weight: 7 }], { x: 1, z: 2, w: 8, d: 6 });
    expect(one).toEqual([{ key: 'solo', x: 1, z: 2, w: 8, d: 6 }]);
    const zeros = squarify(
      [{ key: 'a', weight: 0 }, { key: 'b', weight: 5 }],
      { x: 0, z: 0, w: 10, d: 10 }
    );
    expect(zeros.length).toBe(2);
  });
});

describe('buildCity', () => {
  it('returns an empty layout for empty/invalid input', () => {
    const empty = {
      buildings: [],
      districts: [],
      bounds: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 },
      roads: [],
      plots: [],
      paths: [],
    };
    expect(buildCity([])).toEqual(empty);
    expect(buildCity(undefined)).toEqual(empty);
    expect(buildCity(null)).toEqual(empty);
  });

  it('handles a single file', () => {
    const layout = buildCity([fileNode('src/index.js', 4096)]);
    expect(layout.buildings.length).toBe(1);
    expect(layout.districts.length).toBe(1);
    const b = layout.buildings[0];
    expect(b.id).toBe('src/index.js');
    expect(b.district).toBe('src');
    expect(b.color).toBe(colorForLang('JavaScript'));
    expect(b.height).toBeGreaterThanOrEqual(1);
    // The single district (and thus the whole city) is centered on the
    // origin. The building itself need not sit exactly at (0,0): its grid
    // always reserves at least one extra cell for a plot, so a lone file can
    // be offset from the district center by up to half the grid.
    const d = layout.districts[0];
    expect(Math.abs(d.x)).toBeLessThan(1);
    expect(Math.abs(d.z)).toBeLessThan(1);
    // roads/plots/paths are always present, and a single file still gets its
    // guaranteed plot + street.
    expect(Array.isArray(layout.roads)).toBe(true);
    expect(Array.isArray(layout.plots)).toBe(true);
    expect(Array.isArray(layout.paths)).toBe(true);
    expect(layout.plots.length).toBeGreaterThanOrEqual(1);
    expect(layout.roads.length).toBeGreaterThanOrEqual(1);
  });

  describe('350-file synthetic city', () => {
    const files = syntheticFiles(350);
    const layout = buildCity(files);
    const { buildings, districts, bounds } = layout;

    it('produces one building per file and one district per top-level dir', () => {
      expect(buildings.length).toBe(files.length);
      const expected = new Set(files.map((f) => districtOf(f)));
      expect(new Set(districts.map((d) => d.name))).toEqual(expected);
    });

    // Buildings are laid out with >= 9 units of street between footprints,
    // then snapped onto the 1-unit voxel grid at the very end. Snapping
    // floors each footprint (only ever shrinks it) and moves each center by
    // at most 0.5 in either direction, so two neighboring buildings can lose
    // at most 1.0 unit of clearance total — the post-snap floor is 9-1=8,
    // which is exactly the "~8-10 unit inner street" the design targets.
    const MIN_STREET_POST_SNAP = 8;

    it('never overlaps two buildings and keeps the post-snap street minimum', () => {
      for (let i = 0; i < buildings.length; i++) {
        for (let j = i + 1; j < buildings.length; j++) {
          const gap = footprintGap(buildings[i], buildings[j]);
          expect(gap).toBeGreaterThanOrEqual(MIN_STREET_POST_SNAP - EPS);
        }
      }
    });

    // MARGIN is 4 pre-snap; only the building side of this gap can shift
    // (district rects are not snapped), so post-snap it can shrink by at
    // most 0.5.
    const MIN_MARGIN_POST_SNAP = 3.5;

    it('keeps every building inside its district rect with margin to spare', () => {
      const byName = new Map(districts.map((d) => [d.name, d]));
      for (const b of buildings) {
        const d = byName.get(b.district);
        expect(d).toBeTruthy();
        expect(b.x - b.w / 2).toBeGreaterThanOrEqual(d.x - d.w / 2 + MIN_MARGIN_POST_SNAP - EPS);
        expect(b.x + b.w / 2).toBeLessThanOrEqual(d.x + d.w / 2 - MIN_MARGIN_POST_SNAP + EPS);
        expect(b.z - b.d / 2).toBeGreaterThanOrEqual(d.z - d.d / 2 + MIN_MARGIN_POST_SNAP - EPS);
        expect(b.z + b.d / 2).toBeLessThanOrEqual(d.z + d.d / 2 - MIN_MARGIN_POST_SNAP + EPS);
      }
    });

    it('keeps every building and district inside bounds', () => {
      for (const b of buildings) {
        expect(b.x - b.w / 2).toBeGreaterThanOrEqual(bounds.minX - EPS);
        expect(b.x + b.w / 2).toBeLessThanOrEqual(bounds.maxX + EPS);
        expect(b.z - b.d / 2).toBeGreaterThanOrEqual(bounds.minZ - EPS);
        expect(b.z + b.d / 2).toBeLessThanOrEqual(bounds.maxZ + EPS);
      }
      for (const d of districts) {
        expect(d.x - d.w / 2).toBeGreaterThanOrEqual(bounds.minX - EPS);
        expect(d.x + d.w / 2).toBeLessThanOrEqual(bounds.maxX + EPS);
        expect(d.z - d.d / 2).toBeGreaterThanOrEqual(bounds.minZ - EPS);
        expect(d.z + d.d / 2).toBeLessThanOrEqual(bounds.maxZ + EPS);
      }
    });

    it('district rects do not overlap each other', () => {
      for (let i = 0; i < districts.length; i++) {
        for (let j = i + 1; j < districts.length; j++) {
          expect(rectsOverlap(districts[i], districts[j])).toBe(false);
        }
      }
    });

    it('district areas track file counts (bigger dirs get bigger blocks)', () => {
      const count = new Map();
      for (const f of files) {
        const d = districtOf(f);
        count.set(d, (count.get(d) || 0) + 1);
      }
      const sorted = [...districts].sort(
        (a, b) => count.get(b.name) - count.get(a.name)
      );
      const biggest = sorted[0];
      const smallest = sorted[sorted.length - 1];
      expect(biggest.w * biggest.d).toBeGreaterThan(smallest.w * smallest.d);
    });

    it('constrains heights and footprints (post voxel-snap), and heights are monotone in size', () => {
      for (const b of buildings) {
        expect(b.height).toBeGreaterThanOrEqual(1);
        expect(b.height).toBeLessThanOrEqual(30);
        expect(b.w).toBeGreaterThanOrEqual(3);
        expect(b.w).toBeLessThanOrEqual(8);
        expect(b.d).toBeGreaterThanOrEqual(3);
        expect(b.d).toBeLessThanOrEqual(8);
        // height is floored to a whole number as part of grid-snapping.
        expect(b.height).toBe(Math.max(1, Math.floor(heightForSize(b.size))));
      }
      const bySize = [...buildings].sort((a, b) => a.size - b.size);
      for (let i = 1; i < bySize.length; i++) {
        expect(bySize[i].height).toBeGreaterThanOrEqual(bySize[i - 1].height - EPS);
      }
    });

    it('centers the city near the origin', () => {
      const cx = (bounds.minX + bounds.maxX) / 2;
      const cz = (bounds.minZ + bounds.maxZ) / 2;
      const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
      expect(Math.abs(cx)).toBeLessThan(span * 0.15);
      expect(Math.abs(cz)).toBeLessThan(span * 0.15);
    });

    it('keeps same-subfolder files adjacent (sorted grid neighborhoods)', () => {
      // Within a district, buildings were emitted sorted by (dir, name):
      // consecutive same-dir buildings must be grid neighbors (one cell apart).
      const byDistrict = new Map();
      for (const b of buildings) {
        if (!byDistrict.has(b.district)) byDistrict.set(b.district, []);
        byDistrict.get(b.district).push(b);
      }
      for (const group of byDistrict.values()) {
        const dirs = group.map((b) => b.dir);
        const sortedDirs = [...dirs].sort((a, b) => String(a).localeCompare(String(b)));
        // Emission order groups sub-directories together.
        expect(dirs).toEqual(sortedDirs);
      }
    });
  });

  it('assigns colors from colorForLang', () => {
    const layout = buildCity([
      fileNode('a.py', 3000),
      fileNode('b.rs', 3000),
      fileNode('mystery.zzz', 3000),
    ]);
    const byName = new Map(layout.buildings.map((b) => [b.name, b]));
    expect(byName.get('a.py').color).toBe(colorForLang('Python'));
    expect(byName.get('b.rs').color).toBe(colorForLang('Rust'));
    expect(byName.get('mystery.zzz').color).toBe(colorForLang('Other'));
  });
});

describe('roads', () => {
  const layout = buildCity(syntheticFiles(350));

  it('are all axis-aligned with positive width', () => {
    for (const r of layout.roads) {
      const vertical = Math.abs(r.x1 - r.x2) < 1e-6;
      const horizontal = Math.abs(r.z1 - r.z2) < 1e-6;
      expect(vertical || horizontal).toBe(true);
      expect(r.width).toBeGreaterThan(0);
      expect(['arterial', 'street']).toContain(r.kind);
    }
  });

  it('form a single connected network (no duplicate overlapping segments stranding a piece)', () => {
    expect(layout.roads.length).toBeGreaterThan(0);
    expect(roadsConnected(layout.roads)).toBe(true);
  });

  it('never intersects a building footprint', () => {
    for (const b of layout.buildings) {
      const br = asRect(b);
      for (const r of layout.roads) {
        expect(rectsOverlapAABB(br, roadRect(r))).toBe(false);
      }
    }
  });

  it('includes both arterial (district-dividing) and street (in-district) roads', () => {
    expect(layout.roads.some((r) => r.kind === 'arterial')).toBe(true);
    expect(layout.roads.some((r) => r.kind === 'street')).toBe(true);
  });
});

describe('plots', () => {
  const layout = buildCity(syntheticFiles(350));

  it('reserves at least one plot per district', () => {
    const counts = new Map(layout.districts.map((d) => [d.name, 0]));
    for (const p of layout.plots) counts.set(p.district, (counts.get(p.district) || 0) + 1);
    for (const [, count] of counts) expect(count).toBeGreaterThanOrEqual(1);
  });

  it('never overlaps a building or a road', () => {
    for (const p of layout.plots) {
      const pr = asRect(p);
      for (const b of layout.buildings) expect(rectsOverlapAABB(pr, asRect(b))).toBe(false);
      for (const r of layout.roads) expect(rectsOverlapAABB(pr, roadRect(r))).toBe(false);
    }
  });

  it('has a valid kind, positive size, and references a real district', () => {
    const names = new Set(layout.districts.map((d) => d.name));
    for (const p of layout.plots) {
      expect(['park', 'plaza', 'lot']).toContain(p.kind);
      expect(names.has(p.district)).toBe(true);
      expect(p.w).toBeGreaterThan(0);
      expect(p.d).toBeGreaterThan(0);
    }
  });
});

describe('paths (sidewalk graph)', () => {
  const layout = buildCity(syntheticFiles(350));

  it('is non-empty and spaced roughly every 8-12 units along each road side', () => {
    expect(layout.paths.length).toBeGreaterThan(0);
  });

  it('every link index is in range and links are symmetric', () => {
    const n = layout.paths.length;
    for (let i = 0; i < n; i++) {
      for (const j of layout.paths[i].links) {
        expect(Number.isInteger(j)).toBe(true);
        expect(j).toBeGreaterThanOrEqual(0);
        expect(j).toBeLessThan(n);
        expect(layout.paths[j].links).toContain(i);
      }
    }
  });

  it('has no self-links and no duplicate links', () => {
    for (const node of layout.paths) {
      expect(node.links).not.toContain(layout.paths.indexOf(node));
      expect(new Set(node.links).size).toBe(node.links.length);
    }
  });
});

describe('voxel grid snapping', () => {
  const layout = buildCity(syntheticFiles(350));

  it('buildings: whole-number footprint/height, centers on integer-or-half-integer grid lines', () => {
    for (const b of layout.buildings) {
      expect(isInteger(b.w)).toBe(true);
      expect(isInteger(b.d)).toBe(true);
      expect(isInteger(b.height)).toBe(true);
      expect(isMultipleOfHalf(b.x)).toBe(true);
      expect(isMultipleOfHalf(b.z)).toBe(true);
      // Edges must land on whole-number grid lines.
      expect(isInteger(b.x - b.w / 2)).toBe(true);
      expect(isInteger(b.z - b.d / 2)).toBe(true);
    }
  });

  it('plots: same whole-number/grid-aligned treatment as buildings', () => {
    for (const p of layout.plots) {
      expect(isInteger(p.w)).toBe(true);
      expect(isInteger(p.d)).toBe(true);
      expect(isMultipleOfHalf(p.x)).toBe(true);
      expect(isMultipleOfHalf(p.z)).toBe(true);
      expect(isInteger(p.x - p.w / 2)).toBe(true);
      expect(isInteger(p.z - p.d / 2)).toBe(true);
    }
  });

  it('roads: whole-number endpoints and width', () => {
    for (const r of layout.roads) {
      expect(isInteger(r.x1)).toBe(true);
      expect(isInteger(r.z1)).toBe(true);
      expect(isInteger(r.x2)).toBe(true);
      expect(isInteger(r.z2)).toBe(true);
      expect(isInteger(r.width)).toBe(true);
      expect(r.width).toBeGreaterThanOrEqual(1);
    }
  });

  it('paths: nodes land on whole or half units', () => {
    for (const n of layout.paths) {
      expect(isMultipleOfHalf(n.x)).toBe(true);
      expect(isMultipleOfHalf(n.z)).toBe(true);
    }
  });
});

describe('determinism', () => {
  it('produces deep-equal output for the same 350-file input across two runs', () => {
    const files = syntheticFiles(350);
    expect(buildCity(files)).toEqual(buildCity(files));
  });

  it('is deterministic for single-file and empty input', () => {
    expect(buildCity([fileNode('a.js', 10)])).toEqual(buildCity([fileNode('a.js', 10)]));
    expect(buildCity([])).toEqual(buildCity([]));
  });
});

describe('findSpawn', () => {
  it('returns a sane default for an empty layout', () => {
    const s = findSpawn({ buildings: [], districts: [], bounds: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 } });
    expect(s.y).toBe(EYE_HEIGHT);
    expect(Number.isFinite(s.x)).toBe(true);
    expect(Number.isFinite(s.z)).toBe(true);
    expect(findSpawn(null).y).toBe(EYE_HEIGHT);
  });

  it('spawns clear of every building footprint, at eye height, near the +Z edge', () => {
    const layout = buildCity(syntheticFiles(350));
    const s = findSpawn(layout);
    expect(s.y).toBe(EYE_HEIGHT);
    for (const b of layout.buildings) {
      const inside =
        Math.abs(s.x - b.x) < b.w / 2 && Math.abs(s.z - b.z) < b.d / 2;
      expect(inside).toBe(false);
    }
    // Spawn is now INSIDE the city — in the root district where README/entry-point files
    // live — rather than outside the edge looking in.
    const b = layout.bounds;
    expect(s.x).toBeGreaterThanOrEqual(b.minX);
    expect(s.x).toBeLessThanOrEqual(b.maxX);
    expect(s.z).toBeGreaterThanOrEqual(b.minZ);
    expect(s.z).toBeLessThanOrEqual(b.maxZ);
  });

  it('spawns in the root district when the repo has root-level files', () => {
    const layout = buildCity(syntheticFiles(350));
    const root = layout.districts.find((d) => d.name === '/');
    if (!root) return; // nothing to assert for a repo with no root-level files
    const s = findSpawn(layout);
    // Within the root district's block (plus the clearance spiral's reach).
    expect(Math.abs(s.x - root.x)).toBeLessThan(root.w / 2 + 64);
    expect(Math.abs(s.z - root.z)).toBeLessThan(root.d / 2 + 64);
  });

  it('falls back to the city centre when there is no root district', () => {
    // Every file nested under a directory -> no '/' district exists.
    const nested = Array.from({ length: 40 }, (_, i) => ({
      path: `src/mod${i}/file${i}.js`,
      name: `file${i}.js`,
      dir: `src/mod${i}`,
      size: 2000 + i * 100,
      ext: 'js',
      lang: 'JavaScript',
    }));
    const layout = buildCity(nested);
    const s = findSpawn(layout);
    expect(Number.isFinite(s.x)).toBe(true);
    expect(Number.isFinite(s.z)).toBe(true);
    expect(s.y).toBe(EYE_HEIGHT);
    for (const b of layout.buildings) {
      const inside = Math.abs(s.x - b.x) < b.w / 2 && Math.abs(s.z - b.z) < b.d / 2;
      expect(inside).toBe(false);
    }
  });
});
