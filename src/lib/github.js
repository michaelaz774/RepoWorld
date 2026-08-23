/**
 * GitHub data layer — all repo fetching goes through here.
 *
 * Network calls use the same-origin proxy (`/api/github/...`, auth injected
 * server-side) except raw file contents, which come straight from
 * raw.githubusercontent.com (CORS-open, not rate limited).
 *
 * Shapes conform to src/lib/types.js (RepoRef, FileNode, RawIssue).
 */

import { langForExt } from './types.js';

const MAX_FILES = 350;
const README_MAX = 4000;
const BODY_MAX = 1500;
const FILE_CONTENT_MAX = 20000;

/** Directory segments that never contain interesting source. */
const EXCLUDED_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', 'vendor', '.next', 'target', 'coverage',
]);

/** Exact filenames to skip. */
const EXCLUDED_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
]);

/** Binary-ish / useless extensions to skip. */
const EXCLUDED_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'woff', 'woff2', 'ttf', 'eot',
  'mp4', 'mp3', 'pdf', 'zip', 'gz', 'lock', 'map',
]);

/** Text-ish extensions worth rendering even though EXT_LANG doesn't know them. */
const EXTRA_TEXT_EXTS = new Set([
  'txt', 'toml', 'xml', 'sql', 'ini', 'cfg', 'conf', 'env', 'graphql', 'proto',
  'vue', 'svelte', 'astro', 'lua', 'r', 'scala', 'ex', 'exs', 'erl', 'dart',
  'zig', 'nim', 'hs', 'clj', 'pl', 'ps1', 'bat', 'gradle', 'cmake',
]);

/**
 * Parse user input into a RepoRef.
 * Accepts "https://github.com/owner/repo", "github.com/owner/repo", "owner/repo",
 * trailing ".git", "/tree/<branch>" suffixes, extra whitespace, trailing slashes.
 * @param {string} input
 * @returns {import('./types.js').RepoRef|null} branch '' means "detect default"
 */
export function parseRepoUrl(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;
  // Strip protocol + host prefixes.
  s = s.replace(/^(https?:\/\/)?(www\.)?/i, '');
  s = s.replace(/^github\.com[/:]/i, '');
  // Also handle git@github.com:owner/repo.git
  s = s.replace(/^git@github\.com:/i, '');
  s = s.replace(/[?#].*$/, '');
  s = s.replace(/\/+$/, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0].trim();
  let repo = parts[1].trim().replace(/\.git$/i, '');
  let branch = '';
  if (parts.length >= 4 && (parts[2] === 'tree' || parts[2] === 'blob')) {
    branch = parts.slice(3).join('/');
  }
  const ok = /^[A-Za-z0-9_.-]+$/;
  if (!ok.test(owner) || !ok.test(repo)) return null;
  return { owner, repo, branch };
}

/**
 * Detect the repo's default branch. Falls back to 'main' on any failure.
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<string>}
 */
export async function fetchDefaultBranch(owner, repo) {
  try {
    const res = await fetch(`/api/github/repos/${owner}/${repo}`);
    if (!res.ok) return 'main';
    const data = await res.json();
    return data.default_branch || 'main';
  } catch {
    return 'main';
  }
}

/**
 * Repo metadata + README text. Never throws — returns defaults on failure.
 * @param {import('./types.js').RepoRef} repo
 * @returns {Promise<{description:string, language:string, stars:number, topics:string[], readme:string}>}
 */
export async function fetchRepoMeta(repo) {
  const meta = { description: '', language: '', stars: 0, topics: [], readme: '' };
  try {
    const res = await fetch(`/api/github/repos/${repo.owner}/${repo.repo}`);
    if (res.ok) {
      const data = await res.json();
      meta.description = data.description || '';
      meta.language = data.language || '';
      meta.stars = data.stargazers_count || 0;
      meta.topics = Array.isArray(data.topics) ? data.topics : [];
    }
  } catch {
    // keep defaults
  }
  const branch = repo.branch || 'main';
  for (const name of ['README.md', 'readme.md', 'README.rst']) {
    try {
      const res = await fetch(
        `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${branch}/${name}`
      );
      if (res.ok) {
        const text = await res.text();
        meta.readme = text.slice(0, README_MAX);
        break;
      }
    } catch {
      // try next candidate
    }
  }
  return meta;
}

/**
 * Pure filter: should a repo path (with extension) be turned into a building?
 * @param {string} path repo-relative path
 * @param {string} ext lowercase extension without dot
 * @returns {boolean}
 */
export function shouldIncludePath(path, ext) {
  if (!path || typeof path !== 'string') return false;
  const segments = path.split('/');
  const name = segments[segments.length - 1];
  for (let i = 0; i < segments.length - 1; i++) {
    if (EXCLUDED_DIRS.has(segments[i])) return false;
  }
  if (EXCLUDED_FILES.has(name)) return false;
  const e = String(ext || '').toLowerCase();
  if (EXCLUDED_EXTS.has(e)) return false;
  if (name.toLowerCase().endsWith('.min.js')) return false;
  // Only keep files whose extension we recognize as code/text.
  return langForExt(e) !== 'Other' || EXTRA_TEXT_EXTS.has(e);
}

/**
 * Pure mapper: raw git tree entries -> FileNode[], filtered and capped.
 * Caps at MAX_FILES by size desc so big/important files survive.
 * @param {Array<{path:string, type:string, size?:number}>} tree
 * @returns {import('./types.js').FileNode[]}
 */
export function treeToFileNodes(tree) {
  if (!Array.isArray(tree)) return [];
  const nodes = [];
  for (const entry of tree) {
    if (!entry || entry.type !== 'blob' || typeof entry.path !== 'string') continue;
    const path = entry.path;
    const slash = path.lastIndexOf('/');
    const name = slash === -1 ? path : path.slice(slash + 1);
    const dir = slash === -1 ? '' : path.slice(0, slash);
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    if (!shouldIncludePath(path, ext)) continue;
    nodes.push({
      path,
      name,
      dir,
      size: typeof entry.size === 'number' ? entry.size : 0,
      ext,
      lang: langForExt(ext),
    });
  }
  nodes.sort((a, b) => b.size - a.size);
  return nodes.slice(0, MAX_FILES);
}

/**
 * Fetch the repo file tree as FileNode[].
 * Throws a human-readable Error on 404 (not found) / 403 (rate limit).
 * @param {import('./types.js').RepoRef} repo
 * @returns {Promise<import('./types.js').FileNode[]>}
 */
export async function fetchTree(repo) {
  const branch = repo.branch || (await fetchDefaultBranch(repo.owner, repo.repo));
  const res = await fetch(
    `/api/github/repos/${repo.owner}/${repo.repo}/git/trees/${branch}?recursive=1`
  );
  if (res.status === 404) {
    throw new Error(`Repo ${repo.owner}/${repo.repo} not found (or branch "${branch}" missing).`);
  }
  if (res.status === 403) {
    throw new Error('GitHub rate limit hit — add a GITHUB_TOKEN to .env or try "demo" mode.');
  }
  if (!res.ok) {
    throw new Error(`GitHub tree request failed (${res.status}).`);
  }
  const data = await res.json();
  return treeToFileNodes(data.tree || []);
}

/**
 * Pure mapper: one GitHub issue API item -> RawIssue.
 * @param {Object} item
 * @returns {{number:number,title:string,body:string,labels:string[],comments:number,createdAt:string,url:string,isPR:boolean,changedFiles:string[]}}
 */
export function toRawIssue(item) {
  return {
    number: item.number,
    title: item.title || '',
    body: String(item.body || '').slice(0, BODY_MAX),
    labels: (item.labels || []).map((l) => (typeof l === 'string' ? l : l && l.name) || '').filter(Boolean),
    comments: item.comments || 0,
    createdAt: item.created_at || '',
    url: item.html_url || '',
    isPR: !!item.pull_request,
    changedFiles: [],
  };
}

/**
 * Fetch open issues + PRs (the issues endpoint returns both; split on
 * `pull_request`). For the top 8 PRs by comment count, also fetch their
 * changed-file lists in parallel. Never throws — returns empty lists on
 * failure so the world still renders.
 * @param {import('./types.js').RepoRef} repo
 * @returns {Promise<{issues:Object[], prs:Object[]}>}
 */
export async function fetchIssuesAndPRs(repo) {
  try {
    const res = await fetch(
      `/api/github/repos/${repo.owner}/${repo.repo}/issues?state=open&per_page=100`
    );
    if (!res.ok) return { issues: [], prs: [] };
    const data = await res.json();
    if (!Array.isArray(data)) return { issues: [], prs: [] };
    const issues = [];
    const prs = [];
    for (const item of data) {
      const raw = toRawIssue(item);
      (raw.isPR ? prs : issues).push(raw);
    }
    const top = [...prs].sort((a, b) => b.comments - a.comments).slice(0, 8);
    await Promise.all(
      top.map(async (pr) => {
        try {
          const fres = await fetch(
            `/api/github/repos/${repo.owner}/${repo.repo}/pulls/${pr.number}/files?per_page=100`
          );
          if (!fres.ok) return;
          const files = await fres.json();
          if (Array.isArray(files)) {
            pr.changedFiles = files.map((f) => f && f.filename).filter(Boolean);
          }
        } catch {
          // leave changedFiles empty
        }
      })
    );
    return { issues, prs };
  } catch {
    return { issues: [], prs: [] };
  }
}

/**
 * Fetch a single file's raw content (truncated). Returns '' on failure.
 * @param {import('./types.js').RepoRef} repo
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function fetchFileContent(repo, path) {
  try {
    const branch = repo.branch || 'main';
    const res = await fetch(
      `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${branch}/${path}`
    );
    if (!res.ok) return '';
    const text = await res.text();
    return text.slice(0, FILE_CONTENT_MAX);
  } catch {
    return '';
  }
}

/**
 * Make a memoized file-content fetcher bound to a repo, for the 3D code panels.
 * The same path is only fetched once; concurrent calls share one promise.
 * @param {import('./types.js').RepoRef} repo
 * @returns {(path: string) => Promise<string>}
 */
export function makeCodeFetcher(repo) {
  const cache = new Map();
  return function getCode(path) {
    if (!cache.has(path)) {
      cache.set(path, fetchFileContent(repo, path));
    }
    return cache.get(path);
  };
}
