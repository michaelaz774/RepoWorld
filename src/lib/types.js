/**
 * SHARED DATA CONTRACTS — Repo World
 *
 * This file is the single source of truth for the shapes passed between modules.
 * Every module author: read this first, conform exactly, do not change it.
 * (If a change is truly required, note it in your final report instead of editing.)
 *
 * All positions are in world units. The city lies on the XZ plane, Y is up.
 * Player eye height is 2. Typical building footprint is 2-6 units, height 1-30.
 */

/**
 * @typedef {Object} RepoRef
 * @property {string} owner
 * @property {string} repo
 * @property {string} branch
 */

/**
 * A source file discovered in the repo tree.
 * @typedef {Object} FileNode
 * @property {string} path      Full repo-relative path, e.g. "src/lib/foo.js"
 * @property {string} name      Basename, e.g. "foo.js"
 * @property {string} dir       Parent dir, e.g. "src/lib" ("" for root files)
 * @property {number} size      Bytes (0 if unknown)
 * @property {string} ext       Lowercase extension without dot, e.g. "js"
 * @property {string} lang      Human language name, e.g. "JavaScript" ("Other" if unknown)
 */

/**
 * A file rendered as a building in the city.
 * @typedef {Object} Building
 * @property {string} id        === path (unique key, used to join hazards/edges)
 * @property {string} path
 * @property {string} name
 * @property {string} dir
 * @property {number} size
 * @property {string} ext
 * @property {string} lang
 * @property {number} x         Center X in world units
 * @property {number} z         Center Z in world units
 * @property {number} w         Footprint width  (X extent)
 * @property {number} d         Footprint depth  (Z extent)
 * @property {number} height    Building height (Y extent, base sits at y=0)
 * @property {string} color     Hex color string, e.g. "#f1e05a"
 * @property {string} district  Top-level directory this belongs to ("/" for root)
 */

/**
 * A directory rendered as a city block / plaza under its buildings.
 * @typedef {Object} District
 * @property {string} name      Top-level dir name, or "/" for root
 * @property {number} x         Center X
 * @property {number} z         Center Z
 * @property {number} w         Extent along X
 * @property {number} d         Extent along Z
 * @property {string} color     Hex color for the plaza floor
 */

/**
 * A drivable/walkable road running between city blocks. Axis-aligned.
 * @typedef {Object} RoadSegment
 * @property {string} id
 * @property {number} x1
 * @property {number} z1
 * @property {number} x2
 * @property {number} z2
 * @property {number} width      Full road width in world units (includes both lanes)
 * @property {'arterial'|'street'} kind  arterial = wide district divider, street = inner
 */

/**
 * Open ground inside a district with no building on it — parks, plazas, parking.
 * @typedef {Object} Plot
 * @property {string} id
 * @property {number} x          Center X
 * @property {number} z          Center Z
 * @property {number} w
 * @property {number} d
 * @property {'park'|'plaza'|'lot'} kind
 * @property {string} district
 */

/**
 * A point along the sidewalk network that pedestrians walk between.
 * @typedef {Object} PathNode
 * @property {number} x
 * @property {number} z
 * @property {number[]} links    Indices of connected PathNodes in the same array
 */

/**
 * @typedef {Object} CityLayout
 * @property {Building[]} buildings
 * @property {District[]} districts
 * @property {{minX:number,maxX:number,minZ:number,maxZ:number}} bounds
 * @property {RoadSegment[]} roads    Road network between and within districts
 * @property {Plot[]} plots           Parks/plazas/lots for props and greenery
 * @property {PathNode[]} paths       Sidewalk graph for pedestrian simulation
 */

/**
 * A dependency/import relationship, drawn as a flowing line between buildings.
 * @typedef {Object} DepEdge
 * @property {string} from      Building.id (importer)
 * @property {string} to        Building.id (imported)
 * @property {number} weight    1..5, thickness/intensity hint
 */

/**
 * A physical danger in the world, attached to a building.
 * @typedef {Object} Hazard
 * @property {string} id                 Unique, e.g. "issue-42" | "pr-7" | "risk-src/a.js"
 * @property {string|null} path          Building.id it attaches to; null = unplaced
 * @property {'issue'|'pr'|'risk'} kind
 * @property {number} severity           1..10 (drives fire size, light intensity, radius)
 * @property {string} title              Short label shown in world
 * @property {string} reason             Longer explanation shown on approach
 * @property {string|null} url           Link out to GitHub
 * @property {number|null} number        Issue/PR number
 * @property {number} ageDays            Days since created (0 for 'risk')
 * @property {number} comments           Comment count (0 for 'risk')
 */

/**
 * Everything the 3D scene needs to render a world.
 * @typedef {Object} WorldData
 * @property {RepoRef} repo
 * @property {CityLayout} layout
 * @property {DepEdge[]} edges
 * @property {Hazard[]} hazards
 * @property {string|null} skyboxUrl     Equirectangular image URL, or null for procedural sky
 * @property {string} summary            One-paragraph repo summary (used for skybox prompt + HUD)
 * @property {{files:number,issues:number,prs:number,risks:number}} stats
 */

/**
 * Progress callback shape used by long-running pipeline steps.
 * @typedef {(stage: string, detail?: string) => void} ProgressFn
 */

export const EYE_HEIGHT = 2;

/** Language -> hex color (GitHub linguist-ish). Shared by layout + HUD legend. */
export const LANG_COLORS = {
  JavaScript: '#f1e05a',
  TypeScript: '#3178c6',
  Python: '#3572A5',
  Rust: '#dea584',
  Go: '#00ADD8',
  Java: '#b07219',
  'C++': '#f34b7d',
  C: '#555555',
  'C#': '#178600',
  Ruby: '#701516',
  PHP: '#4F5D95',
  Swift: '#F05138',
  Kotlin: '#A97BFF',
  Shell: '#89e051',
  HTML: '#e34c26',
  CSS: '#563d7c',
  Markdown: '#083fa1',
  JSON: '#292929',
  YAML: '#cb171e',
  Other: '#8b949e',
};

/** Extension -> language name. Shared by github.js (FileNode.lang) and HUD. */
export const EXT_LANG = {
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  ts: 'TypeScript', tsx: 'TypeScript',
  py: 'Python', rs: 'Rust', go: 'Go', java: 'Java',
  cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++',
  c: 'C', h: 'C', cs: 'C#',
  rb: 'Ruby', php: 'PHP', swift: 'Swift', kt: 'Kotlin',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell',
  html: 'HTML', htm: 'HTML',
  css: 'CSS', scss: 'CSS', sass: 'CSS', less: 'CSS',
  md: 'Markdown', mdx: 'Markdown',
  json: 'JSON', yml: 'YAML', yaml: 'YAML',
};

export function langForExt(ext) {
  return EXT_LANG[String(ext || '').toLowerCase()] || 'Other';
}

export function colorForLang(lang) {
  return LANG_COLORS[lang] || LANG_COLORS.Other;
}
