/**
 * World-building pipeline: GitHub repo -> WorldData.
 *
 * Design constraint that shapes everything here: Greptile indexing takes 3-5 minutes
 * and skybox generation 20-60s, but the demo needs a walkable world in ~5 seconds.
 * So this loads PROGRESSIVELY — it emits a playable world as soon as the file tree and
 * issues are in, then re-emits enriched copies as dependency edges, Greptile risks, and
 * the generated sky arrive. Callers just re-render on each emission.
 */
import {
  parseRepoUrl,
  fetchDefaultBranch,
  fetchTree,
  fetchIssuesAndPRs,
  fetchRepoMeta,
  makeCodeFetcher,
} from './github.js';
import { MOCK_WORLD_INPUT, isMockRepo } from './mockData.js';
import { buildCity, findSpawn } from './layout.js';
import { buildEdges } from './deps.js';
import { buildHazards } from './hazards.js';
import {
  greptileAvailable,
  indexRepo,
  waitForIndex,
  queryRisks,
  querySummary,
  mockRisks,
} from './greptile.js';
import { skyboxAvailable, buildPrompt, generateSkybox } from './skybox.js';

/**
 * Deterministic stand-in dependency graph for the offline demo, where no file contents
 * exist to parse. Each file "imports" a couple of shared modules, biased toward lib/util
 * files and same-directory neighbours, which is what a real import graph looks like.
 */
export function syntheticEdges(files) {
  if (!Array.isArray(files) || files.length < 2) return [];
  const paths = files.map((f) => f.path);
  const isShared = (p) => /(^|\/)(lib|util|utils|api|hooks|state|core)(\/|$)/.test(p);
  const shared = paths.filter(isShared);
  const pool = shared.length >= 3 ? shared : paths;

  const hash = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h);
  };

  const counts = new Map();
  const pairs = [];
  for (const from of paths) {
    const h = hash(from);
    const fanout = 1 + (h % 3);
    for (let k = 0; k < fanout; k++) {
      const to = pool[(h + k * 7919) % pool.length];
      if (!to || to === from) continue;
      if (pairs.some((p) => p.from === from && p.to === to)) continue;
      pairs.push({ from, to });
      counts.set(to, (counts.get(to) || 0) + 1);
    }
  }

  return pairs
    .map((p) => ({ ...p, weight: Math.max(1, Math.min(5, counts.get(p.to) || 1)) }))
    .sort((a, b) => b.weight - a.weight || (a.from < b.from ? -1 : 1))
    .slice(0, 250);
}

/** Build the WorldData object from whatever parts are currently available. */
function assemble({ repo, layout, edges, hazards, skyboxUrl, summary, meta, counts }) {
  return {
    repo,
    layout,
    edges,
    hazards,
    skyboxUrl,
    summary,
    meta,
    spawn: findSpawn(layout),
    stats: {
      files: layout.buildings.length,
      issues: counts.issues,
      prs: counts.prs,
      risks: counts.risks,
    },
  };
}

/**
 * @param {string} input Raw user input (URL, owner/repo, or 'demo')
 * @param {{onProgress?: Function, onWorld?: Function, signal?: AbortSignal}} handlers
 * @returns {Promise<Object>} the first playable WorldData (further versions via onWorld)
 */
export async function loadWorld(input, handlers = {}) {
  const { onProgress = () => {}, onWorld = () => {} } = handlers;
  const aborted = () => handlers.signal?.aborted;

  const mock = isMockRepo(input);
  let repo;
  let files;
  let meta;
  let issues = [];
  let prs = [];

  if (mock) {
    onProgress('Loading offline demo repository', 'no network required');
    repo = MOCK_WORLD_INPUT.repo;
    files = MOCK_WORLD_INPUT.files;
    meta = MOCK_WORLD_INPUT.meta;
    issues = MOCK_WORLD_INPUT.issues;
    prs = MOCK_WORLD_INPUT.prs;
  } else {
    const parsed = parseRepoUrl(input);
    if (!parsed) {
      throw new Error(
        `Could not parse "${input}". Try a URL like https://github.com/owner/repo, or just owner/repo.`
      );
    }
    repo = { ...parsed };

    onProgress('Resolving repository', `${repo.owner}/${repo.repo}`);
    if (!repo.branch) repo.branch = await fetchDefaultBranch(repo.owner, repo.repo);

    onProgress('Reading the file tree', `${repo.owner}/${repo.repo}@${repo.branch}`);
    const [tree, repoMeta] = await Promise.all([fetchTree(repo), fetchRepoMeta(repo)]);
    files = tree;
    meta = repoMeta;

    if (!files.length) {
      throw new Error(`No source files found in ${repo.owner}/${repo.repo}.`);
    }

    onProgress('Collecting open issues and pull requests');
    const gh = await fetchIssuesAndPRs(repo);
    issues = gh.issues;
    prs = gh.prs;
  }

  if (aborted()) return null;

  onProgress('Constructing the city', `${files.length} files`);
  const layout = buildCity(files);

  // Immediate risk signal so the world is never empty; replaced by Greptile below.
  const seedRisks = mockRisks(files, 10);
  let hazards = buildHazards({ issues, prs, risks: seedRisks, buildings: layout.buildings });

  const summary =
    meta?.description ||
    `${repo.owner}/${repo.repo} — ${files.length} files, ${issues.length} open issues.`;

  let world = assemble({
    repo,
    layout,
    edges: [],
    hazards,
    skyboxUrl: null,
    summary,
    meta,
    counts: { issues: issues.length, prs: prs.length, risks: seedRisks.length },
  });

  onWorld(world);

  // ---- Background enrichment: never blocks the playable world ----------------
  const republish = (patch) => {
    if (aborted()) return;
    world = { ...world, ...patch };
    onWorld(world);
  };

  const fetchCode = mock ? async () => '' : makeCodeFetcher(repo);

  // Dependency lines
  if (!mock) {
    buildEdges(files, fetchCode, { limit: 120 })
      .then((edges) => republish({ edges }))
      .catch(() => {});
  } else {
    // Offline demo has no file contents to parse, so synthesize a plausible import
    // graph instead — otherwise the flagship "flowing lines" visual is missing.
    republish({ edges: syntheticEdges(files) });
  }

  // Greptile risk analysis (slow: index can take 3-5 min, so it lands whenever it lands)
  if (!mock && greptileAvailable()) {
    (async () => {
      try {
        onProgress('Greptile is indexing the repository', 'this runs in the background');
        await indexRepo(repo);
        const { done } = await waitForIndex(repo, {
          timeoutMs: 300000,
          onProgress: (status, processed, total) =>
            onProgress('Greptile indexing', total ? `${processed}/${total} files` : status),
        });
        if (!done || aborted()) return;
        const [risks, greptileSummary] = await Promise.all([
          queryRisks(repo, { limit: 10 }),
          querySummary(repo),
        ]);
        if (!risks.length || aborted()) return;
        const enriched = buildHazards({ issues, prs, risks, buildings: layout.buildings });
        republish({
          hazards: enriched,
          summary: greptileSummary || world.summary,
          stats: { ...world.stats, risks: risks.length },
          greptileLive: true,
        });
      } catch {
        /* keep the seeded risks */
      }
    })();
  }

  // Generated environment
  if (skyboxAvailable()) {
    (async () => {
      try {
        const prompt = buildPrompt({
          name: `${repo.owner}/${repo.repo}`,
          description: meta?.description || '',
          language: meta?.language || '',
          topics: meta?.topics || [],
          summary,
          fileCount: files.length,
          hazardCount: hazards.length,
        });
        onProgress('Generating the world environment', 'Blockade Labs Skybox');
        const url = await generateSkybox(prompt, {
          onProgress: (status, secs) => onProgress('Generating environment', `${status} ${secs}s`),
        });
        if (url) republish({ skyboxUrl: url });
      } catch {
        /* procedural sky stays */
      }
    })();
  }

  return world;
}

export { makeCodeFetcher };
