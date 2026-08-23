# Repo World — Tech Stack Cheat Sheet

Glance-able reference for demo Q&A. **Numbers in bold are real and measured — quote them.**

---

## The 15-second version

> React + Three.js. A GitHub repo comes in, gets laid out as a city by a squarified
> treemap, and renders as an instanced voxel world. Greptile's API supplies the risk
> analysis and the fix explanations. Everything's client-side except a thin serverless
> proxy that holds the API keys.

---

## Stack

| Layer | What | Why this choice |
|---|---|---|
| Build | **Vite 8** | Instant HMR; we were rewriting the world live all afternoon |
| UI | **React 19** | HUD, panels, landing — plain DOM outside the canvas |
| 3D | **three.js 0.185** | The renderer |
| 3D/React glue | **@react-three/fiber 9** | Three.js as components; declarative scene graph |
| Helpers | **@react-three/drei 10** | `PointerLockControls`, `Text`, `Instances`, `Sky`, `Html` |
| Tests | **Vitest** | **284 tests**, all pure logic — no 3D needed to test the hard parts |
| Deploy | **Vercel** | Static build + `api/` serverless functions for the key proxy |

**Zero other dependencies.** No physics engine, no post-processing library, no asset
pipeline. Every texture and mesh is generated procedurally at runtime.

---

## Architecture in one breath

```
repo URL
 └─ github.js    tree, issues, PRs, file contents   (all GET — never writes)
     └─ layout.js   squarified treemap → districts, buildings, roads, plots, sidewalks
         ├─ hazards.js   issues + PRs + risks → placed monsters
         ├─ deps.js      parse imports → dependency arcs
         ├─ greptile.js  index + query → riskiest files
         └─ chase.js     bug/Greptile sim → kill events → review panel
```

**The key design decision: the pipeline is progressive.** Greptile indexing takes 3–5
minutes; the demo can't wait. So the city renders in seconds using a heuristic risk model,
and Greptile's real findings swap in whenever they land. Same for dependency edges and the
generated sky. Nothing blocks the playable world.

---

## Where everything in the world comes from

**The one-liner:** everything you can *interact with* is real repo data. Everything that's
*scenery* is deterministic decoration derived from the city's shape.

| Thing you see | Comes from | Real repo data? |
|---|---|---|
| **Buildings** | `git/trees?recursive=1` — top 350 files by size | ✅ Yes |
| **Districts** | Top-level directories | ✅ Yes |
| **Glowing arcs** | Imports parsed from ~120 fetched file sources | ✅ Yes |
| **Red bugs** | Open **GitHub issues** + **Greptile risk findings** | ✅ Yes |
| **PR number on a kill** | An existing open **PR** touching that file | ✅ Yes |
| **NPCs + dialogue** | Per-district stats (file counts, languages, hazards) | ✅ Yes |
| **Quests** | Generated from the repo's own structure | ✅ Yes |
| **Code in panels** | Live from `raw.githubusercontent.com` | ✅ Yes |
| **Greptile creatures** | The player's *tool* — 4 spawned at hashed points | ❌ Not data |
| **Pedestrians** | 120 agents walking the sidewalk graph | ❌ Scenery |
| **Trees, props, roads** | Derived from the layout's roads and plots | ❌ Scenery |

### Bugs — the important one

Two different sources become monsters:

- **`issue` bugs** — every open GitHub issue. Severity is computed: label weight
  (`critical`/`security`/`p0` = 8, `bug`/`regression` = 6, `docs`/`chore` = 2), plus comment
  count (contested = hotter), plus age (long-festering = hotter), clamped 1–10.
- **`risk` bugs** — **Greptile's** answer to "which files are most likely to cause a
  production incident." These have **no GitHub issue** — they're problems nobody has filed.

**Placement is the hard part.** An issue has to land on the *right building*, or the demo
falls apart. Four tiers, best match wins:

1. A PR's actual changed files (strongest signal)
2. An explicit path in the title/body (`src/auth/session.ts`)
3. A bare filename mention (`session.ts`)
4. A module/directory word (`auth`, `parser`), with a stopword list

Anything unmatched is distributed across the largest buildings rather than dropped — the
world never silently loses an issue. Capped at 60 total and 3 per building so one file
doesn't become an unreadable pile.

### Greptile creatures — not data

The 4 roaming Greptiles are **gameplay**, not repo state. They spawn at deterministic
hashed points and wander until you deploy one. `assignTarget` picks the **nearest idle**
creature, and if all four are busy it preempts the closest — so pressing `E` is never a
no-op.

### NPCs — generated from real per-district stats

One Guide plus up to 8 district residents. Each role is chosen from actual aggregates:
the district with the **highest total hazard severity** gets a **Mechanic**, the one holding
the **biggest file** gets a **Foreman**, a docs/Markdown-dominant district gets a
**Librarian**, everyone else is a **Resident**. Their dialogue quotes that district's real
file count, dominant language, and biggest file — so talking to them actually teaches you
the repo.

### Quests — 7 archetypes, all data-driven

Find the entry point · tour N districts · visit the biggest file · exterminate N bugs ·
kill the highest-severity bug · follow an import edge to its target · talk to N locals.
Each is skipped gracefully when the data doesn't exist (no hazards → no exterminator quest).

### Beacon colors

🔴 **Red** = bug · 🟢 **Green** = Greptile · 🟡 **Gold** = NPC with a quest ·
🔵 **Blue** = NPC quest in progress

---

## Where Greptile actually is (be precise — judges will probe)

1. **Risk monsters** — `queryRisks` asks Greptile for the riskiest files with severity and
   reasoning. Those become the amber `risk` bugs: dangers **nobody filed an issue for**.
   That's the differentiator — GitHub gives you known problems, Greptile finds unknown ones.
2. **Fix explanations** — the review panel POSTs to Greptile's `/query` for what's wrong and
   how to fix it, rendered as the before/after diff and the plain-English "why this matters."

**Free-text problem:** Greptile returns prose, not JSON — there's no schema-enforcement
param. We put the JSON shape in the prompt, then parse defensively with three tiers:
strip fences → parse → fall back to the structured `sources[]` array → fall back to a local
heuristic. **The demo cannot break on a bad LLM response.**

---

## Performance (all measured)

| | |
|---|---|
| Triangles | **989k → 310k** (~69% cut) |
| How | Ground was rendering full 12-tri cubes for a flat surface; swapped to 2-tri top-only tiles |
| Real bottleneck | **Not geometry — lights.** 20 hazards each had a live point light, and forward-lit materials pay per-light cost on every lit surface in view. Capped to nearest 6. |
| Frame time | avg **10.6ms**, p95 **16.7ms** |
| Draw calls | ~90–115 for the entire city |
| Crowd | 120 pedestrians = 720 boxes in **2 draw calls** |

**Everything repeated is instanced** — one `InstancedMesh` per material, one shared
`BoxGeometry` for the whole world, textures generated once, **zero allocation inside the
frame loop**.

---

## Determinism

**No `Math.random()` anywhere in the codebase.** Every placement, color, and animation phase
is seeded from a hash of a stable string (usually the file path). Same repo → identical
city, every load. Makes the demo repeatable and the tests meaningful.

---

## Security posture

- Keys live **server-side only** — Vite proxy locally, serverless functions on Vercel.
- The browser only ever receives booleans (`__HAS_GREPTILE__`).
- **Every GitHub call is a GET.** Verified by instrumenting `fetch` at runtime through a
  full kill cycle: `{ GET: 5 }`, zero writes.
- A read-only token is all this needs — safe to demo on someone else's repo.

---

## Likely questions

**"Does it actually open PRs?"**
No — it's a simulation, and we're upfront about that. The PR number shown is a *real
existing* open PR that touches that file, read from GitHub. The fix is a real Greptile
proposal, but nothing is committed. Approve advances the game, not your git history.

**"Does it work on any repo?"**
Yes, any public one. Capped at 350 files by size so huge repos still render fast.
`facebook/react` works — 350 files, 31 issues, 69 PRs.

**"What if the wifi dies?"**
Type `demo` — a full offline world with no network at all.

**"Why voxel?"**
Deliberate. Blocky geometry is cheap, reads as intentional rather than unfinished, and is
approachable — it makes a codebase feel explorable instead of intimidating.

**"How is this different from a file-tree visualizer?"**
Those show you structure. This makes problems *physical* — you don't read that a file is
risky, you see a monster outside it with a beam of light you can spot from across the city.

**"How long did this take?"**
One afternoon, with Codex as the primary coding agent.

---

## If something breaks live

| Symptom | Do this |
|---|---|
| Blank screen | Refresh. Known R3F ResizeObserver race; it self-heals on a retry timer. |
| Rate limit error | You're on a server without the token — use the one with `.env` loaded. |
| Anything else | Type `demo` — offline world, no dependencies, always works. |
