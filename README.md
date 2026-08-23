# Repo World

Paste a GitHub repo, walk through it in 3D. Files are buildings, directories are districts,
imports are flowing lines, and open issues / PRs / Greptile-flagged risky files burn as
physical fire on the buildings they affect.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # vitest
npm run build && npm run preview
```

Type `demo` in the input to run fully offline with no network at all.

## API keys (all optional)

The app works with **zero keys** — public GitHub reads, a procedural sky, and a heuristic
risk model. Adding keys upgrades it. Create `.env` in this directory:

```sh
GREPTILE_API_KEY=   # real codebase risk analysis (otherwise: local heuristic)
GITHUB_TOKEN=       # required BY Greptile for indexing; also lifts the GitHub rate
                    # limit from 60/hr to 5000/hr (otherwise: public, unauthenticated)
BLOCKADE_API_KEY=   # AI-generated sky environment (otherwise: procedural dusk sky)
```

These are read server-side by the Vite proxy in `vite.config.js` and are **never bundled
into the browser**. Frontend code calls same-origin paths (`/api/github`, `/api/greptile`,
`/api/skybox`) and the proxy attaches auth.

Note: Greptile indexing takes 3–5 minutes on a fresh repo. The world does not wait for it —
it renders immediately with heuristic risks and swaps in Greptile's findings when they land.

## Controls

WASD / arrows move · Shift sprint · Space jump (rise in fly) · C descend · **F fly** ·
Esc release cursor. Walk up to a building to read its source.

## Layout

- `src/lib/` — pure logic, all unit tested: `github` (fetch), `layout` (treemap city),
  `deps` (imports → edges), `hazards` (issues/PRs/risks → dangers), `greptile`, `skybox`,
  `pipeline` (progressive orchestration), `types.js` (shared contracts)
- `src/components/` — R3F scene: `Player`, `Buildings`, `Hazards`, `DependencyLines`,
  `SkyEnvironment`, `Ground`, plus `HUD` / `Minimap` DOM overlay
