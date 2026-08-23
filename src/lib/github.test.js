import { describe, it, expect, vi } from 'vitest';
import {
  parseRepoUrl,
  shouldIncludePath,
  treeToFileNodes,
  toRawIssue,
  makeCodeFetcher,
} from './github.js';
import { MOCK_WORLD_INPUT, isMockRepo } from './mockData.js';
import { EXT_LANG, langForExt } from './types.js';

describe('parseRepoUrl', () => {
  it('parses a full https URL', () => {
    expect(parseRepoUrl('https://github.com/facebook/react')).toEqual({
      owner: 'facebook', repo: 'react', branch: '',
    });
  });

  it('parses without protocol', () => {
    expect(parseRepoUrl('github.com/vercel/next.js')).toEqual({
      owner: 'vercel', repo: 'next.js', branch: '',
    });
  });

  it('parses bare owner/repo', () => {
    expect(parseRepoUrl('torvalds/linux')).toEqual({
      owner: 'torvalds', repo: 'linux', branch: '',
    });
  });

  it('strips trailing .git', () => {
    expect(parseRepoUrl('https://github.com/foo/bar.git')).toEqual({
      owner: 'foo', repo: 'bar', branch: '',
    });
  });

  it('extracts branch from /tree/<branch>', () => {
    expect(parseRepoUrl('https://github.com/foo/bar/tree/develop')).toEqual({
      owner: 'foo', repo: 'bar', branch: 'develop',
    });
  });

  it('handles branch names with slashes', () => {
    expect(parseRepoUrl('github.com/foo/bar/tree/feature/new-ui')).toEqual({
      owner: 'foo', repo: 'bar', branch: 'feature/new-ui',
    });
  });

  it('tolerates whitespace and trailing slashes', () => {
    expect(parseRepoUrl('  https://github.com/foo/bar/  ')).toEqual({
      owner: 'foo', repo: 'bar', branch: '',
    });
  });

  it('handles www prefix and query strings', () => {
    expect(parseRepoUrl('https://www.github.com/foo/bar?tab=readme')).toEqual({
      owner: 'foo', repo: 'bar', branch: '',
    });
  });

  it('rejects garbage input', () => {
    expect(parseRepoUrl('')).toBeNull();
    expect(parseRepoUrl('   ')).toBeNull();
    expect(parseRepoUrl('just-one-word')).toBeNull();
    expect(parseRepoUrl('https://gitlab.com')).toBeNull();
    expect(parseRepoUrl(null)).toBeNull();
    expect(parseRepoUrl(undefined)).toBeNull();
    expect(parseRepoUrl(42)).toBeNull();
  });
});

describe('shouldIncludePath', () => {
  it('keeps normal source files', () => {
    expect(shouldIncludePath('src/App.jsx', 'jsx')).toBe(true);
    expect(shouldIncludePath('lib/util.py', 'py')).toBe(true);
    expect(shouldIncludePath('config.toml', 'toml')).toBe(true);
  });

  it('excludes vendored / generated directories anywhere in the path', () => {
    expect(shouldIncludePath('node_modules/react/index.js', 'js')).toBe(false);
    expect(shouldIncludePath('packages/app/node_modules/x/y.js', 'js')).toBe(false);
    expect(shouldIncludePath('dist/bundle.js', 'js')).toBe(false);
    expect(shouldIncludePath('build/main.js', 'js')).toBe(false);
    expect(shouldIncludePath('.git/HEAD', '')).toBe(false);
    expect(shouldIncludePath('vendor/lib.rb', 'rb')).toBe(false);
    expect(shouldIncludePath('.next/server/page.js', 'js')).toBe(false);
    expect(shouldIncludePath('target/debug/main.rs', 'rs')).toBe(false);
    expect(shouldIncludePath('coverage/lcov.info', 'info')).toBe(false);
  });

  it('excludes lockfiles', () => {
    expect(shouldIncludePath('package-lock.json', 'json')).toBe(false);
    expect(shouldIncludePath('yarn.lock', 'lock')).toBe(false);
    expect(shouldIncludePath('pnpm-lock.yaml', 'yaml')).toBe(false);
  });

  it('excludes minified and map files', () => {
    expect(shouldIncludePath('dist2/app.min.js', 'js')).toBe(false);
    expect(shouldIncludePath('src/app.js.map', 'map')).toBe(false);
  });

  it('excludes binary-ish extensions', () => {
    for (const ext of ['png', 'jpg', 'svg', 'woff2', 'mp4', 'pdf', 'zip', 'gz']) {
      expect(shouldIncludePath(`assets/file.${ext}`, ext)).toBe(false);
    }
  });

  it('excludes unrecognized extensions and extensionless files', () => {
    expect(shouldIncludePath('data/blob.xyzq', 'xyzq')).toBe(false);
    expect(shouldIncludePath('Makefile', '')).toBe(false);
  });
});

describe('treeToFileNodes', () => {
  const blob = (path, size) => ({ path, type: 'blob', size });

  it('maps blobs to FileNode shape', () => {
    const nodes = treeToFileNodes([blob('src/lib/foo.ts', 123)]);
    expect(nodes).toEqual([{
      path: 'src/lib/foo.ts', name: 'foo.ts', dir: 'src/lib',
      size: 123, ext: 'ts', lang: 'TypeScript',
    }]);
  });

  it('handles root files and missing sizes', () => {
    const nodes = treeToFileNodes([{ path: 'index.html', type: 'blob' }]);
    expect(nodes[0].dir).toBe('');
    expect(nodes[0].size).toBe(0);
    expect(nodes[0].lang).toBe('HTML');
  });

  it('skips non-blob entries and filtered paths', () => {
    const nodes = treeToFileNodes([
      { path: 'src', type: 'tree' },
      blob('node_modules/x.js', 10),
      blob('logo.png', 999),
      blob('src/ok.js', 5),
    ]);
    expect(nodes.map((n) => n.path)).toEqual(['src/ok.js']);
  });

  it('caps at 350 files keeping the largest', () => {
    const tree = [];
    for (let i = 0; i < 500; i++) tree.push(blob(`src/f${i}.js`, i));
    const nodes = treeToFileNodes(tree);
    expect(nodes).toHaveLength(350);
    // Largest survives, smallest 150 are dropped.
    expect(nodes[0].size).toBe(499);
    expect(Math.min(...nodes.map((n) => n.size))).toBe(150);
  });

  it('is defensive against bad input', () => {
    expect(treeToFileNodes(null)).toEqual([]);
    expect(treeToFileNodes(undefined)).toEqual([]);
    expect(treeToFileNodes([null, {}, { type: 'blob' }])).toEqual([]);
  });
});

describe('toRawIssue', () => {
  it('maps a GitHub issue item and truncates the body', () => {
    const raw = toRawIssue({
      number: 7, title: 'Bug', body: 'x'.repeat(3000),
      labels: [{ name: 'bug' }, 'critical', { name: null }],
      comments: 4, created_at: '2026-01-01T00:00:00Z',
      html_url: 'https://github.com/a/b/issues/7',
    });
    expect(raw.number).toBe(7);
    expect(raw.body).toHaveLength(1500);
    expect(raw.labels).toEqual(['bug', 'critical']);
    expect(raw.isPR).toBe(false);
    expect(raw.changedFiles).toEqual([]);
  });

  it('flags PRs via the pull_request key', () => {
    expect(toRawIssue({ number: 1, pull_request: {} }).isPR).toBe(true);
  });

  it('defaults missing fields', () => {
    const raw = toRawIssue({ number: 2 });
    expect(raw.title).toBe('');
    expect(raw.body).toBe('');
    expect(raw.labels).toEqual([]);
    expect(raw.comments).toBe(0);
  });
});

describe('makeCodeFetcher', () => {
  it('returns a function and caches per path (shares one promise)', async () => {
    const stub = vi.fn(async () => ({ ok: true, text: async () => 'code' }));
    vi.stubGlobal('fetch', stub);
    try {
      const fetcher = makeCodeFetcher({ owner: 'a', repo: 'b', branch: 'main' });
      expect(typeof fetcher).toBe('function');
      const p1 = fetcher('src/x.js');
      const p2 = fetcher('src/x.js');
      expect(p1).toBe(p2); // same cached promise
      await expect(p1).resolves.toBe('code');
      await fetcher('src/y.js');
      expect(stub).toHaveBeenCalledTimes(2); // one fetch per unique path
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('MOCK_WORLD_INPUT', () => {
  it('has a valid RepoRef', () => {
    const { repo } = MOCK_WORLD_INPUT;
    expect(typeof repo.owner).toBe('string');
    expect(typeof repo.repo).toBe('string');
    expect(typeof repo.branch).toBe('string');
  });

  it('has ~40 files conforming to the FileNode shape', () => {
    const { files } = MOCK_WORLD_INPUT;
    expect(files.length).toBeGreaterThanOrEqual(35);
    for (const f of files) {
      expect(typeof f.path).toBe('string');
      expect(f.path.length).toBeGreaterThan(0);
      expect(typeof f.name).toBe('string');
      expect(typeof f.dir).toBe('string');
      expect(f.path).toBe(f.dir ? `${f.dir}/${f.name}` : f.name);
      expect(typeof f.size).toBe('number');
      expect(f.size).toBeGreaterThan(0);
      expect(f.ext).toBe(f.ext.toLowerCase());
      expect(f.lang).toBe(langForExt(f.ext));
    }
  });

  it('has unique file paths across several directories', () => {
    const paths = MOCK_WORLD_INPUT.files.map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
    const dirs = new Set(MOCK_WORLD_INPUT.files.map((f) => f.dir.split('/')[0] || '/'));
    expect(dirs.size).toBeGreaterThanOrEqual(3);
  });

  it('has issues and PRs conforming to the RawIssue shape', () => {
    const { issues, prs } = MOCK_WORLD_INPUT;
    expect(issues.length).toBeGreaterThanOrEqual(8);
    expect(prs.length).toBeGreaterThanOrEqual(4);
    for (const it2 of [...issues, ...prs]) {
      expect(typeof it2.number).toBe('number');
      expect(typeof it2.title).toBe('string');
      expect(typeof it2.body).toBe('string');
      expect(it2.body.length).toBeLessThanOrEqual(1500);
      expect(Array.isArray(it2.labels)).toBe(true);
      expect(typeof it2.comments).toBe('number');
      expect(typeof it2.createdAt).toBe('string');
      expect(Number.isNaN(Date.parse(it2.createdAt))).toBe(false);
      expect(typeof it2.url).toBe('string');
      expect(typeof it2.isPR).toBe('boolean');
      expect(Array.isArray(it2.changedFiles)).toBe(true);
    }
    for (const i of issues) expect(i.isPR).toBe(false);
    for (const p of prs) expect(p.isPR).toBe(true);
  });

  it('PR changedFiles reference real paths from the file list', () => {
    const paths = new Set(MOCK_WORLD_INPUT.files.map((f) => f.path));
    for (const pr of MOCK_WORLD_INPUT.prs) {
      expect(pr.changedFiles.length).toBeGreaterThan(0);
      for (const cf of pr.changedFiles) expect(paths.has(cf)).toBe(true);
    }
  });

  it('has meta with readme and topics', () => {
    const { meta } = MOCK_WORLD_INPUT;
    expect(typeof meta.description).toBe('string');
    expect(typeof meta.language).toBe('string');
    expect(typeof meta.stars).toBe('number');
    expect(Array.isArray(meta.topics)).toBe(true);
    expect(typeof meta.readme).toBe('string');
    expect(meta.readme.length).toBeLessThanOrEqual(4000);
  });

  it('mock file extensions are all recognized by EXT_LANG or text-ish', () => {
    // Sanity: nothing in the mock would be filtered out by shouldIncludePath.
    for (const f of MOCK_WORLD_INPUT.files) {
      expect(shouldIncludePath(f.path, f.ext)).toBe(true);
      if (EXT_LANG[f.ext]) expect(f.lang).toBe(EXT_LANG[f.ext]);
    }
  });
});

describe('isMockRepo', () => {
  it('matches demo/mock/empty', () => {
    expect(isMockRepo('demo')).toBe(true);
    expect(isMockRepo('  MOCK ')).toBe(true);
    expect(isMockRepo('')).toBe(true);
    expect(isMockRepo(null)).toBe(true);
    expect(isMockRepo(undefined)).toBe(true);
  });

  it('rejects real repo inputs', () => {
    expect(isMockRepo('facebook/react')).toBe(false);
    expect(isMockRepo('https://github.com/foo/bar')).toBe(false);
  });
});
