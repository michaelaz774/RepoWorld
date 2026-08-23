/**
 * City layout — turns a flat FileNode[] into a CityLayout (see types.js).
 *
 * Districts = top-level directories, tiled with a squarified treemap
 * (Bruls, Huizing, van Wijk) sized by file count. Inside each district,
 * buildings sit on a regular grid sorted by sub-directory then name so
 * files from the same folder form walkable neighborhoods. A slice of each
 * district's grid cells is reserved as open ground (parks/plazas/lots)
 * instead of buildings, and every district emits its own inner street
 * grid; districts are separated by wide arterial roads that run along the
 * treemap's own tile boundaries (which is what keeps the whole road
 * network gapless and connected). A sidewalk graph (PathNode[]) is derived
 * from the finished road network for pedestrian simulation.
 *
 * World rules honored here:
 * - city on the XZ plane, +Y up, building bases at y=0, city centered on origin
 * - >= 8 world units of street clearance between any two building footprints
 *   (measured after voxel-grid snapping; see below)
 * - >= 3 units of margin between buildings and their district boundary (also
 *   after snapping)
 * - every emitted Building/Plot/RoadSegment/PathNode coordinate lands on the
 *   1-unit voxel grid (footprints/heights/road widths are whole numbers;
 *   centers land on integers or half-integers so edges sit on whole-number
 *   grid lines; path nodes land on whole or half units) — the world is a
 *   Minecraft-style block grid, so nothing may straddle a half-block seam.
 */

import { EYE_HEIGHT, colorForLang } from './types.js';

const STREET = 9;              // min gap between building footprints (inner streets)
const STREET_ROAD_WIDTH = 4;   // paved width of an inner street
const ARTERIAL_GAP = 16;       // min gap between adjacent district plazas
const ARTERIAL_ROAD_WIDTH = 10; // paved width of a district-dividing arterial
const DISTRICT_INSET = ARTERIAL_GAP / 2; // district plazas are inset from the
                                          // treemap tile by this on every side,
                                          // leaving ARTERIAL_GAP between plazas
const MARGIN = 4;              // min gap between a building and its district edge
const RESERVE_FRAC = 0.15;     // rough fraction of each district's grid cells
                                // reserved as open ground (parks/plazas/lots)
const PLOT_PULLBACK = STREET_ROAD_WIDTH / 2 + 2; // clearance a plot edge keeps
                                                   // from a street's centerline
                                                   // when it borders a street
const SIDEWALK_STEP = 10;      // spacing between sidewalk nodes along a road
const SIDEWALK_GAP = 1.5;      // distance from road edge to its sidewalk
const CROSS_LINK_RADIUS = 9;   // max distance to bridge two sidewalk chains

/** @param {Object} file FileNode @returns {string} district name ("/" for root files) */
export function districtOf(file) {
  const dir = (file && file.dir) || '';
  if (!dir) return '/';
  const slash = dir.indexOf('/');
  return slash === -1 ? dir : dir.slice(0, slash);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Log-scaled building height so huge files don't dwarf the city.
 * Typical 2–20KB source files land around 6.5–11.5.
 * @param {number} bytes @returns {number} height in [1.5, 30]
 */
export function heightForSize(bytes) {
  const s = Math.max(0, Number(bytes) || 0);
  return clamp(1.5 + Math.log2(1 + s / 256) * 1.6, 1.5, 30);
}

/** Mildly size-derived square-ish footprint side, in [3, 8]. */
function footprintForSize(bytes) {
  const s = Math.max(0, Number(bytes) || 0);
  return clamp(3 + Math.log2(1 + s / 2048) * 1.15, 3, 8);
}

/** Deterministic hash of a string -> [0, 1). Used for tiny footprint variety. */
function hash01(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/** Mix two hex colors; t=0 -> a, t=1 -> b. */
function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (sh) => {
    const va = (pa >> sh) & 0xff;
    const vb = (pb >> sh) & 0xff;
    return Math.round(va + (vb - va) * t);
  };
  const v = (ch(16) << 16) | (ch(8) << 8) | ch(0);
  return '#' + v.toString(16).padStart(6, '0');
}

/**
 * Squarified treemap (Bruls et al.): tiles `rect` with sub-rects whose areas
 * are proportional to item weights, keeping aspect ratios close to 1.
 * Rects use min-corner convention: {x, z} = corner, {w, d} = extents.
 * @param {{key:string, weight:number}[]} items
 * @param {{x:number, z:number, w:number, d:number}} rect
 * @returns {{key:string, x:number, z:number, w:number, d:number}[]}
 */
export function squarify(items, rect) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  if (list.length === 0 || !rect || rect.w <= 0 || rect.d <= 0) return [];

  const EPS = 1e-9;
  const totalW = list.reduce((s, it) => s + Math.max(it.weight || 0, EPS), 0);
  const scale = (rect.w * rect.d) / totalW;
  // Sort by weight descending (stable tie-break by key) — required by the algorithm.
  const sorted = list
    .map((it) => ({ key: it.key, area: Math.max(it.weight || 0, EPS) * scale }))
    .sort((a, b) => b.area - a.area || String(a.key).localeCompare(String(b.key)));

  const out = [];
  let rem = { x: rect.x, z: rect.z, w: rect.w, d: rect.d };
  let row = [];
  let rowArea = 0;

  // Worst aspect ratio of the current row laid along a side of length `side`.
  const worst = (areas, sum, side) => {
    let mx = 0;
    let mn = Infinity;
    for (const a of areas) {
      if (a > mx) mx = a;
      if (a < mn) mn = a;
    }
    const s2 = sum * sum;
    const w2 = side * side;
    return Math.max((w2 * mx) / s2, s2 / (w2 * mn));
  };

  const layoutRow = () => {
    if (row.length === 0) return;
    if (rem.w >= rem.d) {
      // Row becomes a vertical strip on the left, items stacked along Z.
      const stripW = rem.d > EPS ? rowArea / rem.d : 0;
      let z = rem.z;
      for (const it of row) {
        const h = stripW > EPS ? it.area / stripW : 0;
        out.push({ key: it.key, x: rem.x, z, w: stripW, d: h });
        z += h;
      }
      rem = { x: rem.x + stripW, z: rem.z, w: Math.max(rem.w - stripW, 0), d: rem.d };
    } else {
      // Row becomes a horizontal strip on top, items placed along X.
      const stripD = rem.w > EPS ? rowArea / rem.w : 0;
      let x = rem.x;
      for (const it of row) {
        const w = stripD > EPS ? it.area / stripD : 0;
        out.push({ key: it.key, x, z: rem.z, w, d: stripD });
        x += w;
      }
      rem = { x: rem.x, z: rem.z + stripD, w: rem.w, d: Math.max(rem.d - stripD, 0) };
    }
    row = [];
    rowArea = 0;
  };

  for (const it of sorted) {
    const side = Math.min(rem.w, rem.d);
    if (row.length > 0 && side > EPS) {
      const areas = row.map((r) => r.area);
      const cur = worst(areas, rowArea, side);
      const next = worst(areas.concat(it.area), rowArea + it.area, side);
      if (next > cur) layoutRow();
    }
    row.push(it);
    rowArea += it.area;
  }
  layoutRow();
  return out;
}

// ---------------------------------------------------------------------------
// Voxel-grid snapping. Applied once, at the very end of buildCity, to every
// emitted coordinate. Footprints/heights/widths are floored (never grown, so
// clearances only ever get more generous) to whole numbers >= 1; centers are
// snapped to whichever of {integer, half-integer} keeps their (now whole
// number) extent's edges on integer grid lines.
// ---------------------------------------------------------------------------

function floorMin1(v) {
  return Math.max(1, Math.floor(Number(v) || 0));
}

function nearestHalfInteger(v) {
  return Math.round(v - 0.5) + 0.5;
}

/** Snap a center coordinate so an extent (already a whole number) has integer edges. */
function snapCenter(v, extent) {
  return extent % 2 === 0 ? Math.round(v) : nearestHalfInteger(v);
}

function snapBuildingLike(b) {
  const w = floorMin1(b.w);
  const d = floorMin1(b.d);
  b.w = w;
  b.d = d;
  b.x = snapCenter(b.x, w);
  b.z = snapCenter(b.z, d);
  if (b.height !== undefined) b.height = floorMin1(b.height);
}

function snapRoad(r) {
  const vertical = Math.abs(r.x1 - r.x2) < 1e-6;
  r.width = Math.max(1, Math.round(r.width));
  if (vertical) {
    const x = Math.round(r.x1);
    r.x1 = x;
    r.x2 = x;
    r.z1 = Math.round(r.z1);
    r.z2 = Math.round(r.z2);
  } else {
    const z = Math.round(r.z1);
    r.z1 = z;
    r.z2 = z;
    r.x1 = Math.round(r.x1);
    r.x2 = Math.round(r.x2);
  }
}

function snapPathNode(n) {
  n.x = Math.round(n.x * 2) / 2;
  n.z = Math.round(n.z * 2) / 2;
}

// ---------------------------------------------------------------------------
// Grid-boundary helpers shared by street and plot generation. `idx` walks
// 0..n (n = cols or rows); idx<=0 / idx>=n means "the grid's own outer edge"
// (no street there, just the MARGIN band), interior idx means "the gap
// between cell idx-1 and cell idx".
// ---------------------------------------------------------------------------

/** World coordinate of the boundary before cell `idx`, extended to the tile's
 *  own edge at the ends — used for STREET length (so streets reach the
 *  arterial that runs along the tile edge, keeping the road network joined). */
function tileSpanBoundary(idx, n, centerFn, tileMin, tileMax) {
  if (idx <= 0) return tileMin;
  if (idx >= n) return tileMax;
  return (centerFn(idx - 1) + centerFn(idx)) / 2;
}

/** World coordinate of the boundary before cell `idx`, but never past the
 *  grid's own extent — used for the low (x0/z0) side of a Plot rect. Pulls
 *  back from the gap's centerline by PLOT_PULLBACK when it is an interior
 *  gap (which may carry a street), so plots never reach into a street bed. */
function plotEdgeLo(idx, n, centerFn, cellSize) {
  if (idx <= 0) return centerFn(0) - cellSize / 2;
  if (idx >= n) return centerFn(n - 1) + cellSize / 2;
  return (centerFn(idx - 1) + centerFn(idx)) / 2 + PLOT_PULLBACK;
}

/** Same as plotEdgeLo but for the high (x1/z1) side — pulls back the other way. */
function plotEdgeHi(idx, n, centerFn, cellSize) {
  if (idx <= 0) return centerFn(0) - cellSize / 2;
  if (idx >= n) return centerFn(n - 1) + cellSize / 2;
  return (centerFn(idx - 1) + centerFn(idx)) / 2 - PLOT_PULLBACK;
}

function plotKind(name, idx, area, avgCellArea) {
  if (area > avgCellArea * 2.5) return 'park';
  return hash01(name + '#plotkind#' + idx) < 0.5 ? 'plaza' : 'lot';
}

/** Merge a boolean-indexed run of `needed` flags into contiguous [lo, hi] index runs. */
function mergeRuns(needed) {
  const runs = [];
  let start = -1;
  for (let i = 0; i < needed.length; i++) {
    if (needed[i]) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      runs.push([start, i - 1]);
      start = -1;
    }
  }
  if (start !== -1) runs.push([start, needed.length - 1]);
  return runs;
}

/** Merge overlapping/touching numeric [lo,hi] intervals (continuous coordinates). */
function mergeLineIntervals(intervals) {
  const EPS = 1e-6;
  const sorted = [...intervals].sort((a, b) => a.lo - b.lo);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.lo <= last.hi + EPS) {
      if (iv.hi > last.hi) last.hi = iv.hi;
    } else {
      out.push({ lo: iv.lo, hi: iv.hi });
    }
  }
  return out;
}

/**
 * Build the whole city.
 * @param {Object[]} files FileNode[]
 * @returns {Object} CityLayout {buildings, districts, bounds, roads, plots, paths}
 */
export function buildCity(files) {
  const list = (Array.isArray(files) ? files : []).filter((f) => f && f.path);
  if (list.length === 0) {
    return {
      buildings: [],
      districts: [],
      bounds: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 },
      roads: [],
      plots: [],
      paths: [],
    };
  }

  // 1. Group by district, sort each group by sub-directory then name.
  /** @type {Map<string, Object[]>} */
  const groups = new Map();
  for (const f of list) {
    const d = districtOf(f);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(f);
  }

  const meta = [];
  for (const [name, members] of groups) {
    members.sort(
      (a, b) =>
        String(a.dir || '').localeCompare(String(b.dir || '')) ||
        String(a.name || '').localeCompare(String(b.name || '')) ||
        String(a.path || '').localeCompare(String(b.path || ''))
    );
    // Precompute footprints; the grid cell is the district's max footprint.
    let cellW = 0;
    let cellD = 0;
    const foot = members.map((f) => {
      const base = footprintForSize(f.size);
      const j = 0.9 + 0.2 * hash01(f.path); // ±10% variety, still square-ish
      const w = clamp(base, 3, 8);
      const d = clamp(base * j, 3, 8);
      if (w > cellW) cellW = w;
      if (d > cellD) cellD = d;
      return { w, d };
    });
    // Reserve extra grid cells (beyond one-per-file) for open ground; every
    // district gets at least one (n+1 cells minimum).
    const n = members.length;
    const totalCells = Math.max(n + 1, Math.ceil(n / (1 - RESERVE_FRAC)));
    meta.push({ name, members, foot, cellW, cellD, n, totalCells });
  }

  // 2. Squarified treemap over a unit square, districts weighted by file count.
  const tiles = squarify(
    meta.map((m) => ({ key: m.name, weight: m.members.length })),
    { x: 0, z: 0, w: 1, d: 1 }
  );
  const tileByName = new Map(tiles.map((t) => [t.key, t]));

  // 3. Pick grid dims per district (sized for totalCells, so there's room for
  //    plots) from its tile aspect, then find the single uniform scale F that
  //    makes every grid (+streets +margins) fit its tile.
  const pad = 2 * (MARGIN + DISTRICT_INSET);
  let F = 1;
  for (const m of meta) {
    const t = tileByName.get(m.name);
    const aspect = t.d > 0 ? t.w / t.d : 1;
    m.cols = clamp(Math.round(Math.sqrt(m.totalCells * aspect)) || 1, 1, m.totalCells);
    m.rows = Math.ceil(m.totalCells / m.cols);
    const neededW = m.cols * m.cellW + (m.cols - 1) * STREET + pad;
    const neededD = m.rows * m.cellD + (m.rows - 1) * STREET + pad;
    if (t.w > 0) F = Math.max(F, neededW / t.w);
    if (t.d > 0) F = Math.max(F, neededD / t.d);
  }

  // 4. Emit districts + buildings + per-district streets/plots in world
  //    coordinates, centered on the origin.
  const half = F / 2;
  const buildings = [];
  const districts = [];
  const streetRoads = [];
  const plots = [];
  const outerTiles = []; // {x, z, w, d} per district, for the arterial pass
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const grow = (x0, z0, x1, z1) => {
    if (x0 < minX) minX = x0;
    if (x1 > maxX) maxX = x1;
    if (z0 < minZ) minZ = z0;
    if (z1 > maxZ) maxZ = z1;
  };

  for (const m of meta) {
    const t = tileByName.get(m.name);
    // Outer tile in world units.
    const ox = t.x * F - half;
    const oz = t.z * F - half;
    const ow = t.w * F;
    const od = t.d * F;
    const cx = ox + ow / 2;
    const cz = oz + od / 2;
    outerTiles.push({ x: ox, z: oz, w: ow, d: od });

    // District plaza = tile inset by DISTRICT_INSET (arterial streets between plazas).
    const dw = Math.max(ow - 2 * DISTRICT_INSET, 0);
    const dd = Math.max(od - 2 * DISTRICT_INSET, 0);
    const langCounts = new Map();
    for (const f of m.members) {
      langCounts.set(f.lang, (langCounts.get(f.lang) || 0) + 1);
    }
    let domLang = 'Other';
    let domCount = -1;
    for (const [lang, c] of langCounts) {
      if (c > domCount) {
        domCount = c;
        domLang = lang;
      }
    }
    districts.push({
      name: m.name,
      x: cx,
      z: cz,
      w: dw,
      d: dd,
      color: mixHex(colorForLang(domLang), '#14181f', 0.78),
    });
    grow(cx - dw / 2, cz - dd / 2, cx + dw / 2, cz + dd / 2);

    // Grid of buildings, centered inside the tile. Because the tile is at
    // least `needed` big (step 3), the centered grid keeps >= MARGIN to the
    // inset plaza edge and >= STREET between footprints.
    const { cols, rows, cellW, cellD, n } = m;
    const gridW = cols * cellW + (cols - 1) * STREET;
    const gridD = rows * cellD + (rows - 1) * STREET;
    const startX = cx - gridW / 2 + cellW / 2;
    const startZ = cz - gridD / 2 + cellD / 2;
    const cellCenterX = (c) => startX + c * (cellW + STREET);
    const cellCenterZ = (r) => startZ + r * (cellD + STREET);

    for (let i = 0; i < n; i++) {
      const f = m.members[i];
      const ft = m.foot[i];
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = cellCenterX(col);
      const z = cellCenterZ(row);
      buildings.push({
        id: f.path,
        path: f.path,
        name: f.name,
        dir: f.dir,
        size: f.size,
        ext: f.ext,
        lang: f.lang,
        x,
        z,
        w: ft.w,
        d: ft.d,
        height: heightForSize(f.size),
        color: colorForLang(f.lang),
        district: m.name,
      });
      grow(x - ft.w / 2, z - ft.d / 2, x + ft.w / 2, z + ft.d / 2);
    }

    // Occupancy grid: 'b' = building, 'p' = open ground (plot).
    const occ = [];
    for (let r = 0; r < rows; r++) {
      const rowArr = [];
      for (let c = 0; c < cols; c++) rowArr.push(r * cols + c < n ? 'b' : 'p');
      occ.push(rowArr);
    }

    // Plots: the tail of the row-major fill forms at most two rectangles —
    // the leftover cells in the last partially-filled row, and any fully
    // empty rows below it. This favours a few sizeable open areas over many
    // tiny slivers, and guarantees at least one plot per district.
    const rowOfLast = n > 0 ? Math.floor((n - 1) / cols) : 0;
    const colsUsedInLastRow = n - rowOfLast * cols;
    const avgCellArea = cellW * cellD;
    let plotIdx = 0;

    if (colsUsedInLastRow < cols) {
      const x0 = plotEdgeLo(colsUsedInLastRow, cols, cellCenterX, cellW);
      const x1 = plotEdgeHi(cols, cols, cellCenterX, cellW);
      const z0 = plotEdgeLo(rowOfLast, rows, cellCenterZ, cellD);
      const z1 = plotEdgeHi(rowOfLast + 1, rows, cellCenterZ, cellD);
      const w = x1 - x0;
      const d = z1 - z0;
      if (w > 0.5 && d > 0.5) {
        plots.push({
          id: `${m.name}-plot-${plotIdx}`,
          x: (x0 + x1) / 2,
          z: (z0 + z1) / 2,
          w,
          d,
          kind: plotKind(m.name, plotIdx, w * d, avgCellArea),
          district: m.name,
        });
        plotIdx++;
      }
    }
    if (rowOfLast + 1 <= rows - 1) {
      const x0 = plotEdgeLo(0, cols, cellCenterX, cellW);
      const x1 = plotEdgeHi(cols, cols, cellCenterX, cellW);
      const z0 = plotEdgeLo(rowOfLast + 1, rows, cellCenterZ, cellD);
      const z1 = plotEdgeHi(rows, rows, cellCenterZ, cellD);
      const w = x1 - x0;
      const d = z1 - z0;
      if (w > 0.5 && d > 0.5) {
        plots.push({
          id: `${m.name}-plot-${plotIdx}`,
          x: (x0 + x1) / 2,
          z: (z0 + z1) / 2,
          w,
          d,
          kind: plotKind(m.name, plotIdx, w * d, avgCellArea),
          district: m.name,
        });
        plotIdx++;
      }
    }

    // Inner streets: one segment per contiguous run of "needed" grid gaps.
    // A gap is skipped only where both neighboring cells are plots (so a
    // park doesn't get an internal street cutting through it). Gaps that
    // reach the grid's own ends are extended all the way to the tile edge,
    // which is exactly where the arterial network runs — that's what keeps
    // every district's streets joined to the rest of the road network.
    for (let c = 1; c <= cols - 1; c++) {
      const needed = [];
      for (let r = 0; r < rows; r++) needed.push(!(occ[r][c - 1] === 'p' && occ[r][c] === 'p'));
      for (const [r0, r1] of mergeRuns(needed)) {
        streetRoads.push({
          id: `${m.name}-vs-${c}-${r0}`,
          x1: cellCenterX(c - 1) / 2 + cellCenterX(c) / 2,
          z1: tileSpanBoundary(r0, rows, cellCenterZ, oz, oz + od),
          x2: cellCenterX(c - 1) / 2 + cellCenterX(c) / 2,
          z2: tileSpanBoundary(r1 + 1, rows, cellCenterZ, oz, oz + od),
          width: STREET_ROAD_WIDTH,
          kind: 'street',
        });
      }
    }
    for (let r = 1; r <= rows - 1; r++) {
      const needed = [];
      for (let c = 0; c < cols; c++) needed.push(!(occ[r - 1][c] === 'p' && occ[r][c] === 'p'));
      for (const [c0, c1] of mergeRuns(needed)) {
        streetRoads.push({
          id: `${m.name}-hs-${r}-${c0}`,
          x1: tileSpanBoundary(c0, cols, cellCenterX, ox, ox + ow),
          z1: cellCenterZ(r - 1) / 2 + cellCenterZ(r) / 2,
          x2: tileSpanBoundary(c1 + 1, cols, cellCenterX, ox, ox + ow),
          z2: cellCenterZ(r - 1) / 2 + cellCenterZ(r) / 2,
          width: STREET_ROAD_WIDTH,
          kind: 'street',
        });
      }
    }
  }

  // 5. Arterial roads: collect every district tile's 4 border edges, drop
  //    the ones lying on the outer edge of the whole city (nothing beyond
  //    them needs a road), then merge same-line touching/overlapping
  //    intervals so shared district borders produce ONE road, not duplicate
  //    overlapping ones. Because districts come from a squarify tiling
  //    (always a recursive full-width/full-height strip cut), the resulting
  //    set of interior cut-lines is guaranteed connected as a graph.
  const OUTER_EPS = 1e-6;
  /** @type {Map<string, {orient:'v'|'h', coord:number, intervals:{lo:number,hi:number}[]}>} */
  const edgeGroups = new Map();
  const addEdge = (orient, coord, lo, hi) => {
    if (Math.abs(coord - -half) < OUTER_EPS || Math.abs(coord - half) < OUTER_EPS) return;
    if (hi - lo <= OUTER_EPS) return;
    const key = orient + ':' + coord.toFixed(6);
    if (!edgeGroups.has(key)) edgeGroups.set(key, { orient, coord, intervals: [] });
    edgeGroups.get(key).intervals.push({ lo, hi });
  };
  for (const ot of outerTiles) {
    addEdge('v', ot.x, ot.z, ot.z + ot.d); // left edge
    addEdge('v', ot.x + ot.w, ot.z, ot.z + ot.d); // right edge
    addEdge('h', ot.z, ot.x, ot.x + ot.w); // top edge
    addEdge('h', ot.z + ot.d, ot.x, ot.x + ot.w); // bottom edge
  }
  const arterialRoads = [];
  let artIdx = 0;
  for (const { orient, coord, intervals } of edgeGroups.values()) {
    for (const { lo, hi } of mergeLineIntervals(intervals)) {
      arterialRoads.push({
        id: `art-${orient}-${artIdx++}`,
        x1: orient === 'v' ? coord : lo,
        z1: orient === 'v' ? lo : coord,
        x2: orient === 'v' ? coord : hi,
        z2: orient === 'v' ? hi : coord,
        width: ARTERIAL_ROAD_WIDTH,
        kind: 'arterial',
      });
    }
  }

  const roads = arterialRoads.concat(streetRoads);

  // 6. Sidewalk graph: nodes along both sides of every road, spaced every
  //    ~SIDEWALK_STEP units (including each end), linked sequentially along
  //    their own side; chain endpoints within CROSS_LINK_RADIUS of each
  //    other (i.e. at/near junctions) are cross-linked so the whole graph is
  //    walkable, not a set of disjoint per-road chains.
  const paths = [];
  const endpointIdx = [];
  for (const r of roads) {
    const dx = r.x2 - r.x1;
    const dz = r.z2 - r.z1;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    const ux = dx / len;
    const uz = dz / len;
    const px = -uz;
    const pz = ux;
    const steps = Math.max(1, Math.round(len / SIDEWALK_STEP));
    const offset = r.width / 2 + SIDEWALK_GAP;
    for (const side of [-1, 1]) {
      let prevIdx = -1;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const bx = r.x1 + dx * t;
        const bz = r.z1 + dz * t;
        const nx = bx + px * offset * side;
        const nz = bz + pz * offset * side;
        const idx = paths.length;
        paths.push({ x: nx, z: nz, links: [] });
        if (prevIdx >= 0) {
          paths[prevIdx].links.push(idx);
          paths[idx].links.push(prevIdx);
        }
        if (i === 0 || i === steps) endpointIdx.push(idx);
        prevIdx = idx;
      }
    }
  }
  for (let a = 0; a < endpointIdx.length; a++) {
    for (let b = a + 1; b < endpointIdx.length; b++) {
      const i = endpointIdx[a];
      const j = endpointIdx[b];
      const dx = paths[i].x - paths[j].x;
      const dz = paths[i].z - paths[j].z;
      if (dx * dx + dz * dz > CROSS_LINK_RADIUS * CROSS_LINK_RADIUS) continue;
      if (!paths[i].links.includes(j)) {
        paths[i].links.push(j);
        paths[j].links.push(i);
      }
    }
  }

  // 7. Snap every emitted coordinate onto the 1-unit voxel grid.
  for (const b of buildings) snapBuildingLike(b);
  for (const p of plots) snapBuildingLike(p);
  for (const r of roads) snapRoad(r);
  for (const n of paths) snapPathNode(n);

  return { buildings, districts, bounds: { minX, maxX, minZ, maxZ }, roads, plots, paths };
}

/**
 * A clear standing spot on the city's +Z edge; the city center (origin-ish)
 * lies in the -Z direction from here, so face -Z toward the skyline.
 * @param {Object} layout CityLayout
 * @returns {{x:number, y:number, z:number}}
 */
export function findSpawn(layout) {
  if (!layout || !Array.isArray(layout.buildings) || layout.buildings.length === 0) {
    return { x: 0, y: EYE_HEIGHT, z: 8 };
  }
  // Spawn relative to where the BUILDINGS actually are, not `bounds` — bounds also covers
  // roads, plots and margins, which can sit far outside the built-up area and would strand
  // the player dozens of units away staring at a distant strip of city.
  let minX = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const bd of layout.buildings) {
    if (bd.x - bd.w / 2 < minX) minX = bd.x - bd.w / 2;
    if (bd.x + bd.w / 2 > maxX) maxX = bd.x + bd.w / 2;
    if (bd.z + bd.d / 2 > maxZ) maxZ = bd.z + bd.d / 2;
  }
  const x = (minX + maxX) / 2;
  // Just outside the nearest buildings: close enough that the city fills the view on spawn.
  let z = maxZ + 10;
  // Paranoia: step outward until clear of every footprint (+1 unit of personal space).
  const blocked = (px, pz) =>
    layout.buildings.some(
      (bd) => Math.abs(px - bd.x) < bd.w / 2 + 1 && Math.abs(pz - bd.z) < bd.d / 2 + 1
    );
  for (let tries = 0; tries < 64 && blocked(x, z); tries++) z += 2;
  return { x, y: EYE_HEIGHT, z };
}
