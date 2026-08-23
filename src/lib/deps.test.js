import { describe, it, expect } from 'vitest';
import { extractImports, resolveSpecifier, resolveEdges, buildEdges, MAX_EDGES } from './deps.js';

describe('extractImports', () => {
  it('extracts ES imports (default, named, namespace, side-effect)', () => {
    const src = `
      import React from 'react';
      import { a, b } from './util';
      import * as three from 'three';
      import './styles.css';
    `;
    expect(extractImports(src, 'js')).toEqual(['react', './util', 'three', './styles.css']);
  });

  it('extracts export ... from', () => {
    const src = `export { x } from './x';\nexport * from '../y';`;
    expect(extractImports(src, 'js')).toEqual(['./x', '../y']);
  });

  it('extracts CommonJS require', () => {
    const src = `const fs = require('fs');\nconst util = require( './util' );`;
    expect(extractImports(src, 'cjs')).toEqual(['fs', './util']);
  });

  it('extracts dynamic import()', () => {
    const src = `const mod = await import('./lazy.js');`;
    expect(extractImports(src, 'js')).toContain('./lazy.js');
  });

  it('works for TypeScript extensions', () => {
    const src = `import type { T } from './types';\nimport x from './x';`;
    const specs = extractImports(src, 'tsx');
    expect(specs).toContain('./types');
    expect(specs).toContain('./x');
  });

  it('ignores JS comments', () => {
    const src = `
      // import fake from './commented';
      /* import also from './block'; */
      import real from './real';
    `;
    const specs = extractImports(src, 'js');
    expect(specs).toEqual(['./real']);
  });

  it('extracts Python import and from-import forms', () => {
    const src = `
import os
import numpy as np, sys
from collections import OrderedDict
from pkg.sub import thing
# import commented
`;
    const specs = extractImports(src, 'py');
    expect(specs).toEqual(expect.arrayContaining(['os', 'numpy', 'sys', 'collections', 'pkg.sub']));
    expect(specs).not.toContain('commented');
  });

  it('extracts Go grouped and single imports', () => {
    const src = `
package main

import (
  "fmt"
  api "net/http"
)

import "strings"
`;
    expect(extractImports(src, 'go')).toEqual(expect.arrayContaining(['fmt', 'net/http', 'strings']));
  });

  it('extracts Rust use statements', () => {
    const src = `
use std::collections::HashMap;
pub use crate::util::helpers;
use serde;
`;
    const specs = extractImports(src, 'rs');
    expect(specs).toEqual(
      expect.arrayContaining(['std::collections::HashMap', 'crate::util::helpers', 'serde'])
    );
  });

  it('dedupes repeated specifiers', () => {
    const src = `import a from './a';\nimport b from './a';`;
    expect(extractImports(src, 'js')).toEqual(['./a']);
  });

  it('never throws on weird input', () => {
    expect(extractImports(null, 'js')).toEqual([]);
    expect(extractImports(undefined, 'py')).toEqual([]);
    expect(extractImports(12345, 'go')).toEqual([]);
    expect(extractImports('import "unclosed', 'go')).toBeInstanceOf(Array);
    expect(extractImports('total nonsense $$$', 'unknown-ext')).toEqual([]);
  });
});

describe('resolveSpecifier', () => {
  const pathSet = new Set([
    'src/main.js',
    'src/lib/util.js',
    'src/lib/deps.ts',
    'src/components/App.jsx',
    'src/components/index.js',
    'src/py/mod.py',
    'lib/util.js',
    'unique/only.rs',
  ]);

  it('resolves exact relative paths', () => {
    expect(resolveSpecifier('./lib/util.js', 'src/main.js', pathSet)).toBe('src/lib/util.js');
  });

  it('infers extensions for relative paths', () => {
    expect(resolveSpecifier('./lib/util', 'src/main.js', pathSet)).toBe('src/lib/util.js');
    expect(resolveSpecifier('./lib/deps', 'src/main.js', pathSet)).toBe('src/lib/deps.ts');
    expect(resolveSpecifier('../components/App', 'src/lib/util.js', pathSet)).toBe('src/components/App.jsx');
  });

  it('resolves directory imports to index files', () => {
    expect(resolveSpecifier('./components', 'src/main.js', pathSet)).toBe('src/components/index.js');
  });

  it('resolves ../ traversal', () => {
    expect(resolveSpecifier('../main', 'src/lib/util.js', pathSet)).toBe('src/main.js');
    // resolves to root-level 'main', which does not exist
    expect(resolveSpecifier('../../main', 'src/lib/util.js', pathSet)).toBe(null);
  });

  it('returns null when relative path escapes the repo root', () => {
    expect(resolveSpecifier('../../../nope', 'src/lib/util.js', pathSet)).toBe(null);
  });

  it('matches unambiguous bare specifier suffixes', () => {
    expect(resolveSpecifier('only', 'src/main.js', pathSet)).toBe('unique/only.rs');
    expect(resolveSpecifier('components/App', 'src/main.js', pathSet)).toBe('src/components/App.jsx');
  });

  it('returns null for ambiguous bare specifiers', () => {
    // 'lib/util' matches both src/lib/util.js and lib/util.js
    expect(resolveSpecifier('lib/util', 'src/main.js', pathSet)).toBe(null);
  });

  it('matches Rust :: and Python . forms', () => {
    expect(resolveSpecifier('py::mod', 'src/main.js', pathSet)).toBe('src/py/mod.py');
    expect(resolveSpecifier('py.mod', 'src/main.js', pathSet)).toBe('src/py/mod.py');
  });

  it('returns null for unresolvable or garbage input', () => {
    expect(resolveSpecifier('react', 'src/main.js', pathSet)).toBe(null);
    expect(resolveSpecifier('./missing', 'src/main.js', pathSet)).toBe(null);
    expect(resolveSpecifier('', 'src/main.js', pathSet)).toBe(null);
    expect(resolveSpecifier(null, 'src/main.js', pathSet)).toBe(null);
    expect(resolveSpecifier('./x', 'src/main.js', null)).toBe(null);
  });
});

/** Minimal FileNode factory for tests. */
function fn(path, size = 100) {
  const name = path.split('/').pop();
  const ext = name.includes('.') ? name.split('.').pop() : '';
  return { path, name, dir: path.split('/').slice(0, -1).join('/'), size, ext, lang: 'JavaScript' };
}

describe('resolveEdges', () => {
  it('builds edges, dedupes pairs, and drops self-edges', () => {
    const files = [fn('src/a.js'), fn('src/b.js'), fn('src/c.js')];
    const contents = new Map([
      ['src/a.js', `import b from './b';\nconst again = require('./b');\nimport self from './a';`],
      ['src/b.js', `import c from './c';`],
      ['src/c.js', ''],
    ]);
    const edges = resolveEdges(files, contents);
    expect(edges).toHaveLength(2);
    const keys = edges.map((e) => `${e.from}->${e.to}`).sort();
    expect(keys).toEqual(['src/a.js->src/b.js', 'src/b.js->src/c.js']);
    expect(edges.every((e) => e.from !== e.to)).toBe(true);
  });

  it('drops edges to files not in the file list', () => {
    const files = [fn('src/a.js')];
    const contents = new Map([['src/a.js', `import gone from './gone';`]]);
    expect(resolveEdges(files, contents)).toEqual([]);
  });

  it('computes weight from importer count, clamped to 1..5', () => {
    const files = [
      fn('src/hub.js'),
      ...Array.from({ length: 7 }, (_, i) => fn(`src/u${i}.js`)),
    ];
    const contents = new Map(
      Array.from({ length: 7 }, (_, i) => [`src/u${i}.js`, `import hub from './hub';`])
    );
    contents.set('src/u1.js', `import hub from './hub';\nimport other from './u0';`);
    const edges = resolveEdges(files, contents);
    const hubEdges = edges.filter((e) => e.to === 'src/hub.js');
    expect(hubEdges).toHaveLength(7);
    // 7 importers, clamped to 5
    expect(hubEdges.every((e) => e.weight === 5)).toBe(true);
    const single = edges.find((e) => e.to === 'src/u0.js');
    expect(single.weight).toBe(1);
  });

  it('caps output at 250 edges keeping the highest weights', () => {
    const files = [fn('src/hub.js')];
    const contents = new Map();
    // 300 files each importing the hub, plus one file importing a leaf.
    for (let i = 0; i < 300; i++) {
      files.push(fn(`src/f${i}.js`));
      contents.set(`src/f${i}.js`, `import hub from './hub';`);
    }
    files.push(fn('src/leaf.js'));
    contents.set('src/f0.js', `import hub from './hub';\nimport leaf from './leaf';`);
    const edges = resolveEdges(files, contents);
    expect(edges).toHaveLength(MAX_EDGES);
    expect(MAX_EDGES).toBe(250);
    // The weight-1 leaf edge should have been dropped in favor of weight-5 hub edges.
    expect(edges.every((e) => e.weight === 5)).toBe(true);
  });

  it('handles empty/garbage input without throwing', () => {
    expect(resolveEdges([], new Map())).toEqual([]);
    expect(resolveEdges(null, null)).toEqual([]);
    expect(resolveEdges([fn('a.js')], new Map([['a.js', null]]))).toEqual([]);
  });
});

describe('buildEdges', () => {
  it('fetches code files and resolves edges', async () => {
    const files = [fn('src/a.js', 500), fn('src/b.js', 300), fn('README.md', 9999)];
    const store = {
      'src/a.js': `import b from './b';`,
      'src/b.js': '',
    };
    const fetched = [];
    const edges = await buildEdges(files, async (path) => {
      fetched.push(path);
      return store[path] ?? null;
    });
    expect(edges).toEqual([{ from: 'src/a.js', to: 'src/b.js', weight: 1 }]);
    expect(fetched).not.toContain('README.md'); // non-code files skipped
  });

  it('respects the limit (largest files first) and reports progress', async () => {
    const files = Array.from({ length: 10 }, (_, i) => fn(`src/f${i}.js`, i));
    const fetched = [];
    const progress = [];
    await buildEdges(files, async (p) => (fetched.push(p), ''), {
      limit: 3,
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(fetched).toHaveLength(3);
    // Largest sizes are f9, f8, f7.
    expect(fetched.sort()).toEqual(['src/f7.js', 'src/f8.js', 'src/f9.js']);
    expect(progress).toHaveLength(3);
    expect(progress[progress.length - 1]).toEqual([3, 3]);
  });

  it('caps concurrency at 8', async () => {
    const files = Array.from({ length: 30 }, (_, i) => fn(`src/f${i}.js`));
    let inFlight = 0;
    let maxInFlight = 0;
    await buildEdges(files, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return '';
    });
    expect(maxInFlight).toBeLessThanOrEqual(8);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('never throws — returns [] on total failure', async () => {
    await expect(buildEdges(null, null)).resolves.toEqual([]);
    await expect(
      buildEdges([fn('src/a.js')], async () => {
        throw new Error('network down');
      })
    ).resolves.toEqual([]);
    await expect(buildEdges([fn('src/a.js')], 'not a function')).resolves.toEqual([]);
  });
});
