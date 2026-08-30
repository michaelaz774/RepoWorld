/**
 * wizard.js — the wise wizard's brain, minus the network.
 *
 * Pure logic only: no three.js, no Anthropic SDK, no fetch. This module decides
 * WHAT the wizard knows (the system prompt) and WHAT it can do (the tool set);
 * `wizardClient.js` owns the transport and `Wizard.jsx` owns the body.
 *
 * Everything here is unit-testable under Vitest's node environment like the
 * rest of `src/lib/`.
 *
 * DETERMINISM: this is the one deliberately non-deterministic feature in the
 * app — a live model pilots the wizard, so the same repo will not produce the
 * same conversation twice. That is why the wizard is built here rather than in
 * `quests.js`, whose `generateNpcs` output is asserted deterministic by
 * quests.test.js. Nothing in this file calls Math.random either; the
 * nondeterminism lives entirely in the model's responses.
 *
 * CONTEXT BUDGET: dumping a whole WorldData costs ~13k tokens on the demo repo
 * and ~62k on a 350-file one (layout.paths alone is ~45% of it and has zero
 * value to the wizard). The slim context built here is ~1.7k tokens on the demo
 * world and ~3.2k at 350 files; everything else is reachable through tools.
 */

import { angularOffset } from './targeting.js';

/** Hard caps so a huge repo can't blow up the system prompt. */
const MAX_CONTEXT_BUILDINGS = 220;
const MAX_CONTEXT_HAZARDS = 10;
const MAX_README_CHARS = 1200;
const MAX_TOOL_FILES = 400;
const MAX_FILE_CHARS = 12000;   // per read_file result
const MAX_SEARCH_HITS = 40;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function num(v, fallback = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function str(v, fallback = '') {
  return typeof v === 'string' ? v : fallback;
}
function arr(v) {
  return Array.isArray(v) ? v : [];
}
function round(v, places = 0) {
  const m = 10 ** places;
  return Math.round(num(v) * m) / m;
}
function clip(s, n) {
  const t = str(s);
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

/**
 * Per-district rollup: file count, total bytes, dominant language.
 * @param {Object[]} buildings
 */
export function districtRollup(buildings) {
  const byName = new Map();
  for (const b of arr(buildings)) {
    if (!b) continue;
    const name = str(b.district, '/') || '/';
    let d = byName.get(name);
    if (!d) { d = { district: name, files: 0, bytes: 0, langs: {} }; byName.set(name, d); }
    d.files += 1;
    d.bytes += num(b.size);
    const lang = str(b.lang, 'Other') || 'Other';
    d.langs[lang] = (d.langs[lang] || 0) + 1;
  }
  return [...byName.values()]
    .map((d) => {
      let top = 'Other';
      let best = -1;
      for (const [lang, n] of Object.entries(d.langs)) {
        if (n > best) { best = n; top = lang; }
      }
      return { district: d.district, files: d.files, bytes: d.bytes, mainLang: top };
    })
    .sort((a, b) => b.files - a.files);
}

/**
 * Which slow pipeline stages have actually landed. The pipeline republishes an
 * enriched world several times per load and represents "not ready" only as
 * absent/empty values, so the wizard has to infer it — and must say "still
 * indexing" rather than "no risks found".
 */
export function worldReadiness(world) {
  const edges = arr(world?.edges);
  return {
    dependenciesReady: edges.length > 0,
    // pipeline.js sets greptileLive only on success, never false.
    riskAnalysis: world?.greptileLive === true ? 'greptile' : 'heuristic',
    skyGenerated: !!world?.skyboxUrl,
  };
}

/**
 * The compact world briefing handed to the model at conversation start.
 * @param {Object} world WorldData
 */
export function buildWizardContext(world) {
  const layout = world?.layout || {};
  const buildings = arr(layout.buildings);
  const hazards = arr(world?.hazards);
  const meta = world?.meta || {};
  const repo = world?.repo || {};

  const topHazards = [...hazards]
    .sort((a, b) => num(b?.severity) - num(a?.severity))
    .slice(0, MAX_CONTEXT_HAZARDS)
    .map((h) => ({
      id: str(h?.id),
      kind: str(h?.kind),
      severity: num(h?.severity),
      path: h?.path == null ? null : str(h.path),
      title: clip(h?.title, 80),
    }));

  // Slim building list: enough to point at things, not enough to blow the budget.
  const slim = buildings
    .slice(0, MAX_CONTEXT_BUILDINGS)
    .map((b) => [str(b?.path), round(b?.x), round(b?.z), round(b?.height), str(b?.district, '/')]);

  return {
    repo: { owner: str(repo.owner), repo: str(repo.repo), branch: str(repo.branch) },
    summary: clip(world?.summary, 400),
    stats: world?.stats || {},
    meta: {
      description: clip(meta.description, 300),
      language: str(meta.language),
      stars: num(meta.stars),
      topics: arr(meta.topics).slice(0, 10),
      readme: clip(meta.readme, MAX_README_CHARS),
    },
    bounds: layout.bounds || null,
    spawn: world?.spawn || null,
    districts: arr(layout.districts).map((d) => ({
      name: str(d?.name), x: round(d?.x), z: round(d?.z), w: round(d?.w), d: round(d?.d),
    })),
    districtRollup: districtRollup(buildings),
    topHazards,
    buildingCount: buildings.length,
    buildingsTruncated: buildings.length > MAX_CONTEXT_BUILDINGS,
    buildings: slim,
    readiness: worldReadiness(world),
  };
}

const PERSONA = `You are the Wise Wizard of Repo World — an old, dry-humoured sage who has
lived in this city since it was first compiled. The city IS a real GitHub repository: every
building is a file (height = file size, colour = language), every district is a directory,
every glowing arc between buildings is an import, and every monster roaming the streets is an
open issue or a risk finding. The player is a visitor walking around inside their own codebase.

How to behave:
- Speak like a person, not a docs page. Two or three sentences is usually right. You are in a
  game, and the player is reading you in a small chat box while standing in a street.
- Stay in character, but never invent facts about the repository. If you have not read it, say
  so, then use a tool and read it.
- You have tools. Use them rather than guessing — read the file before describing the file.
- You can walk. When you mention a specific building or district, it is good theatre to
  actually walk there with move_to, or to follow the player when they ask you to lead or come
  along. Move first, then talk about where you are.
- Coordinates are world units on the XZ plane; y is up and you never need it. Keep your
  distance sane — do not teleport across the city mid-sentence without saying you are going.
- If the player asks something you genuinely cannot know (their intentions, the future, private
  repos), be a wizard about it and admit the limit.`;

/**
 * The full system prompt. Kept as one stable string so it can be prompt-cached:
 * the volatile part of a conversation is the messages, not this.
 */
export function buildSystemPrompt(world) {
  const ctx = buildWizardContext(world);
  const r = ctx.readiness;
  const caveats = [
    r.riskAnalysis === 'heuristic'
      ? 'Risk findings are currently HEURISTIC guesses, not real Greptile analysis — Greptile may still be indexing (it takes 3-5 minutes). Say so if asked about risks.'
      : 'Risk findings come from real Greptile analysis of this repo.',
    r.dependenciesReady
      ? 'Import/dependency edges are loaded.'
      : 'Import/dependency edges have NOT loaded yet — list_imports will be empty, which is not the same as "this file imports nothing".',
  ];

  return [
    PERSONA,
    '',
    'What you know about the city you are standing in (everything else is behind a tool):',
    '```json',
    JSON.stringify(ctx, null, 1),
    '```',
    '',
    'Notes on the above:',
    `- "buildings" rows are [path, x, z, height, district]${ctx.buildingsTruncated ? `, truncated to the first ${MAX_CONTEXT_BUILDINGS} of ${ctx.buildingCount} — use list_files or search_paths for the rest` : ''}.`,
    ...caveats.map((c) => `- ${c}`),
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

const OBJ = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

/** Stable JSON for a tool result; tool results must be strings. */
function ok(value) {
  return JSON.stringify(value);
}

/**
 * Build the wizard's tool set.
 *
 * Every dependency is passed as an accessor rather than a value: the pipeline
 * republishes a BRAND NEW world object several times per load, so a tool that
 * closed over a snapshot would answer questions about a stale city.
 *
 * @param {Object} deps
 * @param {() => Object} deps.getWorld       live WorldData
 * @param {() => Object} deps.getChase       live chase sim state (may be null)
 * @param {() => Object} deps.getPlayer      live playerState
 * @param {(path:string) => Promise<string>} deps.readFile
 * @param {Object} deps.control              wizard body control (moveTo/follow/position)
 * @returns {{name:string, description:string, inputSchema:Object, run:Function}[]}
 */
export function createWizardTools({
  getWorld = () => null,
  getChase = () => null,
  getPlayer = () => ({}),
  readFile = null,
  control = {},
} = {}) {
  const layout = () => getWorld()?.layout || {};
  const buildings = () => arr(layout().buildings);
  const findBuilding = (path) => buildings().find((b) => b && b.id === path) || null;

  return [
    {
      name: 'list_files',
      description:
        'List files in the repository (each is a building). Optionally filter to one district (top-level directory). Returns path, language, size in bytes and district.',
      inputSchema: OBJ({
        district: { type: 'string', description: 'Top-level directory to filter to, e.g. "src". Omit for all.' },
        limit: { type: 'integer', description: `Max rows to return (default 100, hard cap ${MAX_TOOL_FILES}).` },
      }),
      run: ({ district, limit }) => {
        const cap = Math.min(num(limit, 100) || 100, MAX_TOOL_FILES);
        const list = buildings()
          .filter((b) => !district || b?.district === district)
          .slice(0, cap)
          .map((b) => ({ path: b.id, lang: b.lang, size: b.size, district: b.district }));
        return ok({ count: list.length, total: buildings().length, files: list });
      },
    },

    {
      name: 'search_paths',
      description:
        'Find files whose path matches a substring (case-insensitive). Cheap and instant. Use this before read_file when you are unsure of the exact path.',
      inputSchema: OBJ({ query: { type: 'string', description: 'Substring to look for in the file path.' } }, ['query']),
      run: ({ query }) => {
        const q = str(query).toLowerCase();
        if (!q) return ok({ matches: [] });
        const matches = buildings()
          .filter((b) => str(b?.id).toLowerCase().includes(q))
          .slice(0, MAX_SEARCH_HITS)
          .map((b) => b.id);
        return ok({ count: matches.length, matches });
      },
    },

    {
      name: 'read_file',
      description:
        "Read a file's actual source from the repository. This is the only way to know what code really does — use it before describing any file in detail.",
      inputSchema: OBJ({ path: { type: 'string', description: 'Exact repo-relative path, e.g. "src/lib/layout.js".' } }, ['path']),
      run: async ({ path }) => {
        const p = str(path);
        if (!p) return ok({ error: 'path is required' });
        if (!findBuilding(p)) {
          return ok({ error: `No file at "${p}" in this repo. Use search_paths to find the real path.` });
        }
        if (typeof readFile !== 'function') {
          return ok({ error: 'Source reading is unavailable in this world.' });
        }
        try {
          const source = await readFile(p);
          if (!source) {
            return ok({ path: p, source: '', note: 'This world has no source available for that file (offline demo world).' });
          }
          return ok({ path: p, truncated: source.length > MAX_FILE_CHARS, source: clip(source, MAX_FILE_CHARS) });
        } catch (err) {
          return ok({ error: `Could not read "${p}": ${err?.message || String(err)}` });
        }
      },
    },

    {
      name: 'describe_building',
      description:
        'Everything the city knows about one file: its size and language, where it stands, which monsters (issues/risks) are attached to it, and what it imports or is imported by.',
      inputSchema: OBJ({ path: { type: 'string', description: 'Exact repo-relative path.' } }, ['path']),
      run: ({ path }) => {
        const p = str(path);
        const b = findBuilding(p);
        if (!b) return ok({ error: `No building for "${p}". Try search_paths.` });
        const world = getWorld();
        const attached = arr(world?.hazards)
          .filter((h) => h?.path === p)
          .map((h) => ({ id: h.id, kind: h.kind, severity: h.severity, title: h.title, reason: clip(h.reason, 300) }));
        const edges = arr(world?.edges);
        return ok({
          path: b.id,
          lang: b.lang,
          size: b.size,
          district: b.district,
          position: { x: round(b.x, 1), z: round(b.z, 1) },
          height: round(b.height, 1),
          hazards: attached,
          imports: edges.filter((e) => e?.from === p).map((e) => e.to).slice(0, 40),
          importedBy: edges.filter((e) => e?.to === p).map((e) => e.from).slice(0, 40),
          note: edges.length === 0 ? 'Dependency edges have not finished loading yet.' : undefined,
        });
      },
    },

    {
      name: 'describe_district',
      description:
        'Summarise one district (a top-level directory / neighbourhood): how many files, how big, dominant language, and its worst hazards. Omit the name to get every district at once.',
      inputSchema: OBJ({ name: { type: 'string', description: 'District name, e.g. "src" or "/" for the repo root.' } }),
      run: ({ name }) => {
        const roll = districtRollup(buildings());
        if (!name) return ok({ districts: roll });
        const want = str(name);
        const row = roll.find((d) => d.district === want);
        if (!row) return ok({ error: `No district "${want}". Known: ${roll.map((d) => d.district).join(', ')}` });
        const world = getWorld();
        const paths = new Set(buildings().filter((b) => b?.district === want).map((b) => b.id));
        const hazards = arr(world?.hazards)
          .filter((h) => h?.path && paths.has(h.path))
          .sort((a, b) => num(b.severity) - num(a.severity))
          .slice(0, 8)
          .map((h) => ({ id: h.id, kind: h.kind, severity: h.severity, title: h.title, path: h.path }));
        const biggest = buildings()
          .filter((b) => b?.district === want)
          .sort((a, b) => num(b.size) - num(a.size))
          .slice(0, 5)
          .map((b) => ({ path: b.id, size: b.size }));
        return ok({ ...row, biggestFiles: biggest, worstHazards: hazards });
      },
    },

    {
      name: 'get_risks',
      description:
        'The monsters in the city: open issues, open PRs and risk findings, worst first. Check readiness first — risks may still be heuristic guesses if Greptile is indexing.',
      inputSchema: OBJ({
        kind: { type: 'string', enum: ['issue', 'pr', 'risk'], description: 'Filter to one kind. Omit for all.' },
        limit: { type: 'integer', description: 'Max rows (default 15).' },
      }),
      run: ({ kind, limit }) => {
        const world = getWorld();
        const cap = Math.min(num(limit, 15) || 15, 50);
        const list = arr(world?.hazards)
          .filter((h) => !kind || h?.kind === kind)
          .sort((a, b) => num(b?.severity) - num(a?.severity))
          .slice(0, cap)
          .map((h) => ({
            id: h.id, kind: h.kind, severity: h.severity, path: h.path,
            title: h.title, reason: clip(h.reason, 240), number: h.number, url: h.url,
          }));
        return ok({ ...worldReadiness(world), count: list.length, hazards: list });
      },
    },

    {
      name: 'list_imports',
      description: 'The glowing arcs between buildings — which files import which. Empty until the dependency stage finishes loading.',
      inputSchema: OBJ({ path: { type: 'string', description: 'Only edges touching this file. Omit for a sample of the whole graph.' } }),
      run: ({ path }) => {
        const edges = arr(getWorld()?.edges);
        if (!edges.length) return ok({ ready: false, edges: [], note: 'Dependency edges have not loaded yet.' });
        const p = str(path);
        const rows = (p ? edges.filter((e) => e?.from === p || e?.to === p) : edges).slice(0, 60);
        return ok({ ready: true, count: rows.length, total: edges.length, edges: rows });
      },
    },

    {
      name: 'locate',
      description:
        'Where is something in the city? Works for a file path, a district name, ' +
        'a living thing ("greptile", "bug", "monster" — returns the NEAREST one to you), ' +
        'a specific creature id, or "player" / "me". Returns world coordinates you can ' +
        'pass straight to move_to, plus how far away it is.',
      inputSchema: OBJ({
        target: {
          type: 'string',
          description: 'A file path, a district name, "greptile", "bug", "player", or a creature id.',
        },
      }, ['target']),
      run: ({ target }) => {
        const t = str(target);
        const key = t.trim().toLowerCase();
        const player = getPlayer() || {};
        const me = typeof control.position === 'function' ? control.position() : null;
        // Measure "nearest" from the wizard himself when he has a body, since he
        // is the one who has to walk there.
        const originX = me && Number.isFinite(me.x) ? me.x : num(player.x);
        const originZ = me && Number.isFinite(me.z) ? me.z : num(player.z);
        const chase = getChase();

        const nearestOf = (listArr, kind) => {
          let best = null;
          let bestD = Infinity;
          for (const it of arr(listArr)) {
            if (!it || !Number.isFinite(it.x) || !Number.isFinite(it.z)) continue;
            if (kind === 'bug' && it.state === 'dead') continue;
            const d = Math.hypot(it.x - originX, it.z - originZ);
            if (d < bestD) { bestD = d; best = it; }
          }
          return best ? { it: best, d: bestD } : null;
        };

        // Living things first — the world's creatures move, so they are the most
        // common thing to ask about and they are not in the layout.
        if (/^(the\s+)?(nearest\s+)?greptile/.test(key) || key === 'greptiles') {
          const hit = nearestOf(chase?.greptiles);
          if (!hit) return ok({ error: 'No Greptiles are roaming right now.' });
          return ok({
            kind: 'greptile', id: hit.it.id,
            x: round(hit.it.x, 1), z: round(hit.it.z, 1),
            mode: hit.it.mode || null, hunting: hit.it.targetId || null,
            distanceFromYou: round(hit.d, 1),
            distanceFromPlayer: round(Math.hypot(hit.it.x - num(player.x), hit.it.z - num(player.z)), 1),
          });
        }
        if (/^(the\s+)?(nearest\s+)?(bug|monster|issue)/.test(key)) {
          const hit = nearestOf(chase?.bugs, 'bug');
          if (!hit) return ok({ error: 'Nothing is roaming right now.' });
          return ok({
            kind: 'bug', id: hit.it.id, title: hit.it.title, severity: hit.it.severity,
            file: hit.it.buildingId || null,
            x: round(hit.it.x, 1), z: round(hit.it.z, 1),
            distanceFromYou: round(hit.d, 1),
          });
        }
        if (key === 'player' || key === 'me' || key === 'the player') {
          return ok({
            kind: 'player', x: round(player.x, 1), z: round(player.z, 1),
            distanceFromYou: round(Math.hypot(num(player.x) - originX, num(player.z) - originZ), 1),
          });
        }
        if (key === 'you' || key === 'wizard' || key === 'me the wizard') {
          if (!me) return ok({ error: 'You have no body in this world.' });
          return ok({ kind: 'wizard', x: round(me.x, 1), z: round(me.z, 1) });
        }
        // A specific creature by id.
        const creature = arr(chase?.greptiles).find((g) => g && g.id === t)
          || arr(chase?.bugs).find((bg) => bg && bg.id === t && bg.state !== 'dead');
        if (creature) {
          return ok({
            kind: arr(chase?.greptiles).includes(creature) ? 'greptile' : 'bug',
            id: creature.id, x: round(creature.x, 1), z: round(creature.z, 1),
            distanceFromYou: round(Math.hypot(creature.x - originX, creature.z - originZ), 1),
          });
        }

        const b = findBuilding(t);
        if (b) {
          return ok({
            kind: 'file', path: b.id,
            x: round(b.x, 1), z: round(b.z, 1),
            distanceFromPlayer: round(Math.hypot(num(b.x) - num(player.x), num(b.z) - num(player.z)), 1),
          });
        }
        const d = arr(layout().districts).find((it) => str(it?.name) === t);
        if (d) {
          return ok({
            kind: 'district', name: d.name,
            x: round(d.x, 1), z: round(d.z, 1),
            distanceFromPlayer: round(Math.hypot(num(d.x) - num(player.x), num(d.z) - num(player.z)), 1),
          });
        }
        return ok({
          error: `Nothing called "${t}" in this city.`,
          hint: 'For files try search_paths; for neighbourhoods describe_district; for living things try "greptile", "bug" or "player".',
        });
      },
    },

    {
      name: 'player_position',
      description:
        'Where the player is standing right now, what they are looking at, whether they are flying or driving, and where you are relative to them.',
      inputSchema: OBJ({}),
      run: () => {
        const p = getPlayer() || {};
        const me = typeof control.position === 'function' ? control.position() : null;
        return ok({
          player: {
            x: round(p.x, 1), z: round(p.z, 1),
            lookingAt: p.focusedBuilding || null,
            flying: !!p.flying, driving: !!p.driving,
            inDanger: round(p.dangerLevel, 2),
          },
          wizard: me ? { x: round(me.x, 1), z: round(me.z, 1), following: !!me.following } : null,
          distance: me ? round(Math.hypot(num(me.x) - num(p.x), num(me.z) - num(p.z)), 1) : null,
        });
      },
    },

    {
      name: 'list_live_bugs',
      description:
        'The monsters currently alive and roaming, plus where the Greptile hunters are. This is live simulation state, not the issue list.',
      inputSchema: OBJ({}),
      run: () => {
        const chase = getChase();
        if (!chase) return ok({ running: false, bugs: [] });
        const bugs = arr(chase.bugs)
          .filter((b) => b && b.state !== 'dead')
          .slice(0, 40)
          .map((b) => ({
            id: b.id, title: b.title, kind: b.kind, severity: b.severity,
            x: round(b.x, 1), z: round(b.z, 1), state: b.state, file: b.buildingId,
          }));
        const greptiles = arr(chase.greptiles).map((g) => ({
          id: g.id, x: round(g.x, 1), z: round(g.z, 1), mode: g.mode, hunting: g.targetId || null,
        }));
        return ok({ running: true, aliveCount: bugs.length, bugs, greptiles });
      },
    },

    {
      name: 'move_to',
      description:
        'Walk to a point in the city. Use this to lead the player somewhere or to stand next to what you are talking about. Cancels following.',
      inputSchema: OBJ({
        x: { type: 'number', description: 'World X.' },
        z: { type: 'number', description: 'World Z.' },
        reason: { type: 'string', description: 'Briefly, why you are going there (shown to nobody; keeps you honest).' },
      }, ['x', 'z']),
      run: ({ x, z }) => {
        if (typeof control.moveTo !== 'function') return ok({ error: 'You cannot move in this world.' });
        const res = control.moveTo(num(x), num(z));
        return ok(res || { moving: true, to: { x: round(x, 1), z: round(z, 1) } });
      },
    },

    {
      name: 'chase_creature',
      description:
        'Walk after a specific Greptile or bug by id, re-routing as it roams. Use this ' +
        'rather than move_to when the thing you want moves — move_to walks to a fixed ' +
        'point, so by the time you arrive the creature has wandered off. Pass an empty ' +
        'id to stop chasing. Get ids from locate or list_live_bugs.',
      inputSchema: OBJ({
        id: { type: 'string', description: 'Creature id, e.g. "g0" or a bug id. Empty string to stop.' },
      }, ['id']),
      run: ({ id }) => {
        if (typeof control.chaseCreature !== 'function') return ok({ error: 'You cannot move in this world.' });
        const wanted = str(id).trim();
        if (!wanted) { control.chaseCreature(null); return ok({ chasing: null }); }
        const chase = getChase();
        const creature = arr(chase?.greptiles).find((g) => g && g.id === wanted)
          || arr(chase?.bugs).find((b) => b && b.id === wanted && b.state !== 'dead');
        if (!creature) return ok({ error: `No living creature with id "${wanted}". Try locate or list_live_bugs.` });
        control.chaseCreature(wanted);
        return ok({
          chasing: wanted,
          nowAt: { x: round(creature.x, 1), z: round(creature.z, 1) },
          note: 'You will keep walking after it until you catch up or stop.',
        });
      },
    },

    {
      name: 'follow_player',
      description: 'Start or stop walking after the player, so you can talk while they explore.',
      inputSchema: OBJ({ follow: { type: 'boolean', description: 'true to start following, false to stop.' } }, ['follow']),
      run: ({ follow }) => {
        if (typeof control.setFollow !== 'function') return ok({ error: 'You cannot move in this world.' });
        control.setFollow(!!follow);
        return ok({ following: !!follow });
      },
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Route planning over the sidewalk graph                              */
/* ------------------------------------------------------------------ */

/**
 * Collision alone only lets him slide along a facade; a building squarely
 * between him and his destination stops him dead. So he plans a route first,
 * over `layout.paths` — the sidewalk graph the city already builds and
 * Pedestrians walk. Those nodes are laid alongside the roads and are therefore
 * building-free by construction, which is exactly what a navigation mesh needs.
 *
 * Adjacency is the SYMMETRIC closure of the authored links, for the same reason
 * crowd.js takes it: the graph is authored per-node and can be asymmetric (A
 * lists B, B does not list A), and a one-way sidewalk would strand him.
 *
 * @param {import('./types.js').PathNode[]} paths
 * @returns {{count:number, xs:Float64Array, zs:Float64Array, adjIndex:Int32Array, adjList:Int32Array}}
 */
export function buildPathGraph(paths) {
  const list = arr(paths);
  const count = list.length;
  const xs = new Float64Array(count);
  const zs = new Float64Array(count);
  const neighbours = [];
  for (let i = 0; i < count; i++) {
    const n = list[i];
    xs[i] = num(n?.x);
    zs[i] = num(n?.z);
    neighbours.push(new Set());
  }
  for (let i = 0; i < count; i++) {
    const links = arr(list[i]?.links);
    for (let k = 0; k < links.length; k++) {
      const j = links[k];
      if (!Number.isInteger(j) || j < 0 || j >= count || j === i) continue;
      neighbours[i].add(j);
      neighbours[j].add(i);   // symmetric closure
    }
  }
  const adjIndex = new Int32Array(count + 1);
  let total = 0;
  for (let i = 0; i < count; i++) { adjIndex[i] = total; total += neighbours[i].size; }
  adjIndex[count] = total;
  const adjList = new Int32Array(total);
  let w = 0;
  for (let i = 0; i < count; i++) for (const j of neighbours[i]) adjList[w++] = j;

  // The sidewalk graph is NOT one connected network — on the demo city it is 11
  // separate islands (444 nodes in the main one, the rest small). Nothing
  // guarantees the node nearest to A and the node nearest to B are joined, so
  // label the components now and let the planner pick a pair that actually is.
  const component = new Int32Array(count).fill(-1);
  let components = 0;
  const stack = [];
  for (let i = 0; i < count; i++) {
    if (component[i] !== -1) continue;
    const id = components++;
    component[i] = id;
    stack.length = 0;
    stack.push(i);
    while (stack.length) {
      const cur = stack.pop();
      for (let e = adjIndex[cur]; e < adjIndex[cur + 1]; e++) {
        const nxt = adjList[e];
        if (component[nxt] === -1) { component[nxt] = id; stack.push(nxt); }
      }
    }
  }
  return { count, xs, zs, adjIndex, adjList, component, components };
}

/** Minimal binary heap of (node, priority) — A* on 600 nodes should not be O(n^2). */
function makeHeap() {
  const nodes = [];
  const prio = [];
  const swap = (a, b) => {
    const n = nodes[a]; nodes[a] = nodes[b]; nodes[b] = n;
    const p = prio[a]; prio[a] = prio[b]; prio[b] = p;
  };
  return {
    get size() { return nodes.length; },
    push(node, p) {
      nodes.push(node); prio.push(p);
      let i = nodes.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (prio[parent] <= prio[i]) break;
        swap(parent, i); i = parent;
      }
    },
    pop() {
      const top = nodes[0];
      const lastNode = nodes.pop();
      const lastPrio = prio.pop();
      if (nodes.length) {
        nodes[0] = lastNode; prio[0] = lastPrio;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let small = i;
          if (l < nodes.length && prio[l] < prio[small]) small = l;
          if (r < nodes.length && prio[r] < prio[small]) small = r;
          if (small === i) break;
          swap(small, i); i = small;
        }
      }
      return top;
    },
  };
}

/**
 * Does the straight line from (x1,z1) to (x2,z2) clip any building?
 *
 * Slab test against each AABB, inflated by `pad` so it answers "can a body of
 * this radius pass", not "does an infinitely thin line pass".
 */
export function segmentHitsBuilding(x1, z1, x2, z2, buildings, pad = WIZARD_RADIUS) {
  const list = arr(buildings);
  const dx = num(x2) - num(x1);
  const dz = num(z2) - num(z1);
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.z)) continue;
    const minX = b.x - (num(b.w, 2) || 2) / 2 - pad;
    const maxX = b.x + (num(b.w, 2) || 2) / 2 + pad;
    const minZ = b.z - (num(b.d, 2) || 2) / 2 - pad;
    const maxZ = b.z + (num(b.d, 2) || 2) / 2 + pad;
    let t0 = 0;
    let t1 = 1;
    let ok = true;
    // X slab, then Z slab.
    for (let axis = 0; axis < 2 && ok; axis++) {
      const p = axis === 0 ? dx : dz;
      const origin = axis === 0 ? num(x1) : num(z1);
      const lo = axis === 0 ? minX : minZ;
      const hi = axis === 0 ? maxX : maxZ;
      if (Math.abs(p) < 1e-9) {
        if (origin < lo || origin > hi) ok = false;
      } else {
        let ta = (lo - origin) / p;
        let tb = (hi - origin) / p;
        if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) ok = false;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Has a moving quarry drifted far enough from the plan to be worth re-routing?
 *
 * Re-planning every frame is wasteful and makes him twitch between two equally
 * good routes; never re-planning sends him to where the creature used to be.
 *
 * @param {{x:number,z:number}|null} plannedFor where the current route was aimed
 * @param {number} nowX @param {number} nowZ where the quarry is now
 * @param {number} threshold
 */
export function shouldReplan(plannedFor, nowX, nowZ, threshold = 8) {
  if (!plannedFor || !Number.isFinite(plannedFor.x) || !Number.isFinite(plannedFor.z)) return true;
  return Math.hypot(num(nowX) - plannedFor.x, num(nowZ) - plannedFor.z) > num(threshold, 8);
}

/**
 * Plan a walking route from (fromX,fromZ) to (toX,toZ).
 *
 * This is a Dijkstra with EVERY node seeded as a source at its straight-line
 * cost from the start, rather than an A* between the two nearest nodes. The
 * difference matters: picking the nearest entry node is a local decision that
 * routinely sets him off in the wrong direction — walking 35 units west to join
 * a sidewalk when the destination is 80 units north. Seeding every node makes
 * the entry point part of what is optimised, so the total journey is minimised
 * rather than just the first step.
 *
 * It also removes the need to reason about the graph's 11 disconnected islands:
 * every component is reachable from the virtual start, so the search picks
 * whichever one actually helps.
 *
 * With `buildings`, a straight walk that clips nothing beats any route, so he
 * does not follow the pavement around a corner he could just walk across.
 *
 * @returns {{x:number,z:number}[]} waypoints, ending at the destination
 */
export function planWizardRoute(graph, fromX, fromZ, toX, toZ, buildings = null) {
  const fx = num(fromX);
  const fz = num(fromZ);
  const tx = num(toX);
  const tz = num(toZ);
  const direct = [{ x: tx, z: tz }];
  const straight = Math.hypot(tx - fx, tz - fz);

  // Do we actually know what is in the way? A caller that passes a list has told
  // us; one that passes nothing has not, and the two cases must not be conflated.
  const known = Array.isArray(buildings);

  // Ignore any building that already contains the start or the destination.
  // If he is standing on a footprint edge — which happens, he is 1 unit wide and
  // the world is dense — then EVERY segment leaving him "hits a building", every
  // node fails the visibility test, and the planner concludes he is entombed and
  // gives up. Getting out of a wall is collision's job; routing should not be
  // paralysed by it.
  const inside = (b, x, z) =>
    b && Number.isFinite(b.x) && Number.isFinite(b.z)
    && Math.abs(x - b.x) <= (num(b.w, 2) || 2) / 2 + WIZARD_RADIUS
    && Math.abs(z - b.z) <= (num(b.d, 2) || 2) / 2 + WIZARD_RADIUS;
  const obstacles = known
    ? buildings.filter((b) => !inside(b, fx, fz) && !inside(b, tx, tz))
    : null;

  // Nothing in the way? Then walking is the shortest path, by definition.
  if (known && !segmentHitsBuilding(fx, fz, tx, tz, obstacles)) return direct;
  if (!graph || !graph.count) return direct;

  const { count, xs, zs, adjIndex, adjList } = graph;
  const dist = new Float64Array(count);
  const prev = new Int32Array(count).fill(-1);
  const done = new Uint8Array(count);
  const open = makeHeap();
  // Seed every node with the cost of walking in off-graph — but only if he could
  // actually walk there. Without this the planner happily joins the pavement by
  // strolling through the very building the route exists to avoid, and the
  // "route" ends up two waypoints long and straight through a wall.
  let anyEntry = false;
  for (let i = 0; i < count; i++) {
    const reachable = !known || !segmentHitsBuilding(fx, fz, xs[i], zs[i], obstacles);
    dist[i] = reachable ? Math.hypot(xs[i] - fx, zs[i] - fz) : Infinity;
    if (reachable) { anyEntry = true; open.push(i, dist[i]); }
  }
  if (!anyEntry) return direct;   // hemmed in; collision will have to sort it out

  while (open.size) {
    const cur = open.pop();
    if (done[cur]) continue;
    done[cur] = 1;
    for (let e = adjIndex[cur]; e < adjIndex[cur + 1]; e++) {
      const nxt = adjList[e];
      if (done[nxt]) continue;
      const step = Math.hypot(xs[nxt] - xs[cur], zs[nxt] - zs[cur]);
      const via = dist[cur] + step;
      if (via < dist[nxt]) {
        dist[nxt] = via;
        prev[nxt] = cur;
        open.push(nxt, via);
      }
    }
  }

  // Best exit node: cheapest total of (walk in + along the graph + walk out),
  // and again only nodes from which the last leg is actually walkable.
  let best = -1;
  let bestCost = Infinity;
  for (let i = 0; i < count; i++) {
    if (!Number.isFinite(dist[i])) continue;
    if (known && segmentHitsBuilding(xs[i], zs[i], tx, tz, obstacles)) continue;
    const cost = dist[i] + Math.hypot(xs[i] - tx, zs[i] - tz);
    if (cost < bestCost) { bestCost = cost; best = i; }
  }
  if (best < 0) return direct;
  // Only prefer the straight line on cost when we do NOT know it is blocked.
  // Once segmentHitsBuilding has said a building is in the way, "but walking
  // through it would be shorter" is not an argument — that was the bug that made
  // every routed walk collapse back to a straight line into a wall.
  if (!known && bestCost >= straight) return direct;

  const route = [];
  for (let i = best; i !== -1; i = prev[i]) route.push({ x: xs[i], z: zs[i] });
  route.reverse();
  route.push({ x: tx, z: tz });   // the destination is usually off the pavement
  return route;
}

/* ------------------------------------------------------------------ */
/* Body steering                                                       */
/* ------------------------------------------------------------------ */

/**
 * How many times human-sized he is. Everything physical scales off this — his
 * reach, his stride, how close he stands — so the number is the single knob for
 * "how big is the wizard" rather than a dozen constants drifting apart.
 */
export const WIZARD_SCALE = 2;

/** Walking pace. Long legs cover more ground: at scale 2 this is 6.4 u/s, about
 *  the player's walking speed, so he keeps up without teleporting. */
export const WIZARD_WALK_SPEED = 3.2 * WIZARD_SCALE;
/** Close enough to the target; stop. Exported so callers and tests express
 *  "has he arrived?" in his terms rather than a magic number. */
export const WIZARD_ARRIVE_EPS = 1.2 * WIZARD_SCALE;
const ARRIVE_EPS = WIZARD_ARRIVE_EPS;
/** How near he stands while following. A giant at arm's length is a wall. */
export const WIZARD_FOLLOW_GAP = 4.5 * WIZARD_SCALE;
const FOLLOW_GAP = WIZARD_FOLLOW_GAP;
const TURN_RATE = 6;             // rad/s while walking
const LISTEN_TURN_RATE = 9;      // faster: turning to listen should read as deliberate
const IDLE_TURN_RATE = 3;        // ambient "notices you" turn
const STEP_MAX_DT = 0.05;
/** Radians of stride phase per world unit walked. crowd.js uses 1.8 for a
 *  1.8-unit pedestrian; divide by the scale so a giant takes long slow strides
 *  rather than sprinting his legs at twice the cadence over the same ground. */
const STRIDE_FREQ = 1.8 / WIZARD_SCALE;
/** Collision radius, scaled with him: a giant that stopped 0.5 units from a wall
 *  would have his shoulders inside it. */
export const WIZARD_RADIUS = 0.5 * WIZARD_SCALE;
/** How long he may shove at a wall before giving up on an unreachable target.
 *  Without this he would grind against a facade forever, because the agent that
 *  sent him there has no idea he never arrived. */
const STUCK_TIMEOUT = 1.5;
const STUCK_PROGRESS = 0.25;   // fraction of the intended step that counts as progress
/** Intermediate waypoints are passed through, not stopped at, so the tolerance
 *  is tighter than ARRIVE_EPS or he cuts corners into the buildings the route
 *  was drawn to avoid. */
const WAYPOINT_EPS = 1.0 * WIZARD_SCALE;

/* ------------------------------------------------------------------ */
/* Aiming at him                                                       */
/* ------------------------------------------------------------------ */

/** Half-angle of the aim cone, before his size is taken into account. */
const AIM_CONE_DEGREES = 7;
/** How much of his body counts as a hit — feet to hat, sampled up the middle. */
const AIM_SAMPLES = 5;
const AIM_BODY_HEIGHT = 3.4 * WIZARD_SCALE;   // rig height, matches Wizard.jsx
const AIM_BODY_RADIUS = 0.45 * WIZARD_SCALE;

/**
 * Is the player's crosshair actually ON the wizard?
 *
 * Proximity alone is not enough: standing near him is not the same as looking at
 * him, and a prompt that fires while you face the other way is noise.
 *
 * Two things make this behave at every range. He is TALL and thin, so a single
 * centre point would miss his hat and his feet — the offset is sampled up his
 * body and the closest sample wins, the same trick targeting.js uses to make a
 * bug's beacon column hittable. And the cone is widened by his angular radius,
 * `atan(r / distance)`, so a fixed cone does not become impossibly tight at
 * arm's length (where he fills the screen) or absurdly loose far away.
 *
 * @param {{x,y,z,dirX,dirY,dirZ}} camera plain object, as targeting.js expects
 * @param {{x:number,z:number}} wizard
 * @param {{maxDistance?:number, coneDegrees?:number}} [opts]
 */
export function isAimedAtWizard(camera, wizard, opts = {}) {
  if (!camera || !wizard) return false;
  // Both ends must be real. Coercing a NaN position to 0 would silently place
  // him at the world origin and report "you are looking right at him".
  if (!Number.isFinite(camera.x) || !Number.isFinite(camera.y) || !Number.isFinite(camera.z)) return false;
  if (!Number.isFinite(wizard.x) || !Number.isFinite(wizard.z)) return false;
  const wx = wizard.x;
  const wz = wizard.z;
  const cx = camera.x;
  const cz = camera.z;

  const maxDistance = Number.isFinite(opts.maxDistance) ? opts.maxDistance : 14;
  const groundDist = Math.hypot(wx - cx, wz - cz);
  if (groundDist > maxDistance) return false;

  const coneDegrees = Number.isFinite(opts.coneDegrees) ? opts.coneDegrees : AIM_CONE_DEGREES;
  // Widen the cone by how large he looks from here.
  const dist = Math.max(groundDist, 1e-3);
  const angularRadius = Math.atan(AIM_BODY_RADIUS / dist);
  const limit = (coneDegrees * Math.PI) / 180 + angularRadius;

  let best = Math.PI;
  for (let i = 0; i < AIM_SAMPLES; i++) {
    const y = (AIM_BODY_HEIGHT * (i + 0.5)) / AIM_SAMPLES;
    const off = angularOffset(camera, { x: wx, y, z: wz });
    if (off < best) best = off;
  }
  return best <= limit;
}


/**
 * Push the wizard out of any building he has stepped into, along ONE axis.
 *
 * Axes are resolved separately (X, then Z) for the same reason Player.jsx does
 * it: resolving both at once pins you to a corner, whereas one axis at a time
 * lets him slide along a wall and round it. `buildings` is expected to be a
 * pre-filtered candidate list, not the whole city.
 *
 * @param {{x:number,z:number}} body
 * @param {Array} buildings
 * @param {0|1} axis 0 = X, 1 = Z
 * @returns {boolean} true if it had to push
 */
export function collideWizardAxis(body, buildings, axis) {
  if (!body || !Array.isArray(buildings)) return false;
  let hit = false;
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.z)) continue;
    const hx = (num(b.w, 2) || 2) / 2 + WIZARD_RADIUS;
    const hz = (num(b.d, 2) || 2) / 2 + WIZARD_RADIUS;
    const dx = body.x - b.x;
    const dz = body.z - b.z;
    if (dx <= -hx || dx >= hx || dz <= -hz || dz >= hz) continue;
    if (axis === 0) body.x = b.x + (dx >= 0 ? hx : -hx);
    else body.z = b.z + (dz >= 0 ? hz : -hz);
    hit = true;
  }
  return hit;
}

/** Shortest signed angle from `a` to `b`, in (-PI, PI]. */
export function angleDelta(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/** Yaw that faces (tx,tz) from (x,z), in Player.jsx's convention (0 faces -Z). */
export function yawToward(x, z, tx, tz) {
  return Math.atan2(-(tx - x), -(tz - z));
}

/**
 * Advance the wizard's body one frame. Mutates and returns `body`, matching
 * stepVehicle/stepCrowd, so the render loop allocates nothing.
 *
 * `listening` is the important one: while the player is typing, the wizard
 * stops wherever he is and turns to face them. He does NOT forget where he was
 * going — the target and follow flag survive, so he carries on the moment you
 * stop typing. Walking away mid-sentence is what made him feel like scenery.
 *
 * @param {{x:number,z:number,yaw:number,targetX:?number,targetZ:?number,following:boolean}} body
 * @param {Object} input
 * @param {number} input.playerX
 * @param {number} input.playerZ
 * @param {boolean} input.listening  player is typing at him
 * @param {boolean} input.near       player is within talking distance
 * @param {number} dt seconds
 */
export function stepWizardBody(body, input = {}, dt = 0) {
  if (!body) return body;
  const step = Math.min(num(dt), STEP_MAX_DT);
  if (step <= 0) return body;

  const px = num(input.playerX);
  const pz = num(input.playerZ);
  const listening = !!input.listening;

  if (!Number.isFinite(body.x)) body.x = 0;
  if (!Number.isFinite(body.z)) body.z = 0;
  if (!Number.isFinite(body.yaw)) body.yaw = 0;

  // Ease toward the wanted heading, then re-wrap: yaw is read straight into
  // three's rotation.y, and letting it accumulate past +-PI forever makes the
  // value useless for debugging (and for comparing two headings).
  const turnTo = (want, rate) => {
    const next = body.yaw + angleDelta(body.yaw, want) * Math.min(1, rate * step);
    body.yaw = angleDelta(0, next);
  };

  // Stop and listen. Targets are preserved, not cleared.
  if (listening) {
    turnTo(yawToward(body.x, body.z, px, pz), LISTEN_TURN_RATE);
    body.moving = false;
    return body;
  }
  if (!Number.isFinite(body.phase)) body.phase = 0;

  // A live target (a creature he is chasing) overrides everything: it moves, so
  // there is no point walking a stale route to where it used to be. The caller
  // re-plans when it drifts; this just always steers at the current position.
  const live = input.liveTarget;
  if (live && Number.isFinite(live.x) && Number.isFinite(live.z)) {
    body.targetX = live.x;
    body.targetZ = live.z;
  }

  // Where is he headed? A planned route takes priority: each waypoint is
  // consumed as he passes it, and the final one is the real destination.
  let tx = null;
  let tz = null;
  // Only the last leg of a route is an "arrival"; the rest are passed through.
  let onFinalLeg = true;
  const route = Array.isArray(body.route) ? body.route : null;
  if (route && route.length) {
    let idx = Number.isInteger(body.routeIndex) ? body.routeIndex : 0;
    while (idx < route.length) {
      const wp = route[idx];
      const last = idx === route.length - 1;
      const reach = last ? ARRIVE_EPS : WAYPOINT_EPS;
      if (wp && Math.hypot(num(wp.x) - body.x, num(wp.z) - body.z) > reach) break;
      idx++;
    }
    body.routeIndex = idx;
    if (idx >= route.length) {
      // Arrived at the end of the route.
      body.route = null;
      body.routeIndex = 0;
      body.targetX = null;
      body.targetZ = null;
      body.moving = false;
      return body;
    }
    tx = num(route[idx].x);
    tz = num(route[idx].z);
    onFinalLeg = idx === route.length - 1;
  } else if (body.following) {
    const dx = body.x - px;
    const dz = body.z - pz;
    const d = Math.hypot(dx, dz);
    if (d > FOLLOW_GAP) {
      tx = px + (dx / (d || 1)) * FOLLOW_GAP;
      tz = pz + (dz / (d || 1)) * FOLLOW_GAP;
    }
  } else if (Number.isFinite(body.targetX) && Number.isFinite(body.targetZ)) {
    tx = body.targetX;
    tz = body.targetZ;
  }

  if (tx == null) {
    if (input.near) turnTo(yawToward(body.x, body.z, px, pz), IDLE_TURN_RATE);
    body.moving = false;
    return body;
  }

  const dx = tx - body.x;
  const dz = tz - body.z;
  const dist = Math.hypot(dx, dz);
  const arriveAt = onFinalLeg ? ARRIVE_EPS : WAYPOINT_EPS;
  if (dist <= arriveAt) {
    if (onFinalLeg) {
      if (!body.following) { body.targetX = null; body.targetZ = null; }
      body.route = null;
      body.routeIndex = 0;
    } else {
      // Waypoint reached — take the next one on the following frame.
      body.routeIndex = (body.routeIndex || 0) + 1;
    }
    body.moving = false;
    return body;
  }

  const advance = Math.min(WIZARD_WALK_SPEED * step, dist);
  const buildings = Array.isArray(input.buildings) ? input.buildings : null;
  const fromX = body.x;
  const fromZ = body.z;

  // Integrate and collide one axis at a time so he slides along a facade
  // instead of sticking to it.
  body.x += (dx / dist) * advance;
  if (buildings) collideWizardAxis(body, buildings, 0);
  body.z += (dz / dist) * advance;
  if (buildings) collideWizardAxis(body, buildings, 1);

  turnTo(Math.atan2(-dx, -dz), TURN_RATE);

  // Gait is driven by distance ACTUALLY covered, not by time or by intent: he
  // cannot moonwalk on the spot, and his legs stop when he is pressed to a wall.
  const travelled = Math.hypot(body.x - fromX, body.z - fromZ);
  body.phase = angleDelta(0, num(body.phase) + travelled * STRIDE_FREQ);
  body.moving = travelled > 1e-6;

  // Give up on somewhere he cannot reach, rather than shoving at it forever.
  if (travelled < advance * STUCK_PROGRESS) {
    body.stuckFor = num(body.stuckFor) + step;
    if (body.stuckFor >= STUCK_TIMEOUT) {
      body.stuckFor = 0;
      body.blocked = true;
      body.route = null;
      body.routeIndex = 0;
      if (!body.following) { body.targetX = null; body.targetZ = null; }
    }
  } else {
    body.stuckFor = 0;
    body.blocked = false;
  }
  return body;
}

/**
 * A clear place for the wizard to stand: a short walk from the player's spawn,
 * but not inside a building.
 *
 * The city is dense and `spawn` sits in the root district, so a blind offset
 * lands him inside a facade about as often as not. This spirals outward from
 * the offset point the same way layout.js's findSpawn does, and falls back to
 * the raw offset rather than returning nothing.
 *
 * @param {Object} layout CityLayout
 * @param {{x:number,z:number}} spawn
 * @param {number} preferredDistance
 */
export function pickWizardHome(layout, spawn, preferredDistance = 14) {
  const sx = num(spawn?.x);
  const sz = num(spawn?.z);
  const buildings = arr(layout?.buildings);
  const CLEARANCE = WIZARD_RADIUS + 1.2;

  const blocked = (x, z) => buildings.some((b) => {
    if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.z)) return false;
    const hw = (num(b.w, 2) || 2) / 2 + CLEARANCE;
    const hd = (num(b.d, 2) || 2) / 2 + CLEARANCE;
    return Math.abs(x - b.x) <= hw && Math.abs(z - b.z) <= hd;
  });

  // Sweep angles at the preferred distance first, then widen the ring.
  for (let r = preferredDistance; r <= preferredDistance + 24; r += 3) {
    for (let a = 0; a < 12; a++) {
      const th = (a / 12) * Math.PI * 2;
      const x = sx + Math.cos(th) * r;
      const z = sz + Math.sin(th) * r;
      if (!blocked(x, z)) return { x: round(x, 2), z: round(z, 2) };
    }
  }
  return { x: round(sx + preferredDistance, 2), z: round(sz, 2) };
}

/**
 * Keep a conversation bounded without corrupting it.
 *
 * A transcript cannot begin with a tool_result — the matching tool_use would
 * have been trimmed away with the assistant turn that made it, and the API
 * rejects the orphan. So after dropping the oldest messages, walk forward to
 * the next plain user turn.
 *
 * @param {Array} messages
 * @param {number} max
 */
export function trimHistory(messages, max = 40) {
  const list = arr(messages);
  if (list.length <= max) return list;
  let out = list.slice(list.length - max);
  while (out.length) {
    const first = out[0];
    const isToolResult = Array.isArray(first?.content)
      && first.content.some((b) => b?.type === 'tool_result');
    if (first?.role === 'user' && !isToolResult) break;
    out = out.slice(1);
  }
  return out;
}

/** Exposed for tests and for the panel's "what can it do" affordance. */
export const WIZARD_TOOL_NAMES = [
  'list_files', 'search_paths', 'read_file', 'describe_building', 'describe_district',
  'get_risks', 'list_imports', 'locate', 'player_position', 'list_live_bugs',
  'move_to', 'follow_player', 'chase_creature',
];

export const WIZARD_LIMITS = {
  MAX_CONTEXT_BUILDINGS, MAX_CONTEXT_HAZARDS, MAX_README_CHARS,
  MAX_TOOL_FILES, MAX_FILE_CHARS, MAX_SEARCH_HITS,
};
