# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

mem-world is a "second brain on a sphere": a Google-Earth-like globe where markdown notes and PDFs arrange themselves by semantic similarity, forming islands and continents. **`DESIGN.md` is the canonical spec** — read it before making architectural changes; update it when decisions change.

## Commands

Backend (Python 3.12, managed by uv — never pip or system python):

```sh
uv sync --directory /Users/rhee/claude/mem-world/backend
uv run --directory /Users/rhee/claude/mem-world/backend uvicorn memworld.main:app --reload --port 8000
```

Frontend (bun — never npm):

```sh
bun install --cwd /Users/rhee/claude/mem-world/frontend
bun run --cwd /Users/rhee/claude/mem-world/frontend dev      # http://localhost:5173, proxies /api → :8000
bun run --cwd /Users/rhee/claude/mem-world/frontend build    # typecheck (tsc) + bundle
```

There is no test suite yet. The fastest end-to-end check: start both processes, drop a `.md` file into `vault/`, and confirm it appears on the globe within a few seconds.

## Architecture

Two processes plus a files-as-truth vault:

- **`vault/`** — drop directory of `.md`/`.pdf` files; the content source of truth. All derived data (positions, embeddings, links, tags, rev counter) lives in SQLite + sqlite-vec at `vault/.memworld/index.db`. Deleting the DB is safe — it rebuilds from files — but item positions and pins are lost.
- **`backend/src/memworld/`** — FastAPI. `world.py` is the orchestrator: a single `World` instance guarded by an RLock; every mutation bumps a `rev` counter that the frontend polls (`GET /api/world?since=rev`). `vault.py` parses files (wikilinks, tags, PDF text) and watches the drop dir (watchdog → debounced full rescan; rescans are cheap because ingest is hash-gated). `embeddings.py` runs a local sentence-transformers model (must stay cross-platform: macOS dev machine + Linux/Windows Strix Halo box — no MLX/Metal-only deps). `layout.py` maps embeddings to **unit vectors on the unit sphere**: spherical UMAP (haversine output metric) for cold starts with enough items, greedy kNN placement for small worlds and incremental arrivals, then a force-settle pass for de-overlap. Items with `pinned=1` are never moved by layout.
- **`frontend/src/`** — Three.js, no framework. The terrain is generated geometry, not an asset: `globe.ts` evaluates a gaussian density field over item positions at every vertex of a non-indexed icosphere, displacing dense regions up out of a low-poly water sphere (flat shading, one color band per face by height). Sea level is **adaptive** — a density quantile keeps land ≈1/3 of the surface as the world fills, so the ocean never drowns. `Globe.elevation()` is the single source of truth for terrain height — cards, arcs, cluster labels, and the camera floor all sample it. `controls.ts` is a custom Google-Earth-style camera (`GlobeControls`): the camera targets a point ON the surface; the tangent frame is **parallel-transported** with the target (never derived from a world axis — that's what made panning jump at the poles); left-drag pans with true grab-the-ground speed (pan signs were verified empirically — don't "fix" them from first principles), wheel zooms, holding right/middle mouse tilts/orbits around the current focus; all motion eases through smoothed state (`viewDistance` exposes the smoothed zoom for LOD). Cards are re-oriented every frame (`orientCards` in `main.ts`) to keep their text up aligned with the camera's up. Zoom LOD lives in `main.ts` (`applyLod`): cards crossfade out and `clusters.ts` region labels (leader clustering on geodesic distance — single-linkage chained the whole world into one region; named by dominant tag or most central title) fade in; clicking a label flies into the region. `ui.ts` owns the side panel: markdown view/edit/delete for notes (writes back through the API to vault files), a lazy pdf.js reader for PDFs (the on-terrain scroll-strip from DESIGN.md is not built yet), and full-size image view. Image items (`.png/.jpg/...`) carry no extracted text — the FILENAME is the semantics (name artwork files `artist-name-work-title.jpg` so they land near their artist). `scene.ts` has stars/atmosphere/lights. `main.ts` owns the scene graph, polling, raycasting (click = select or fly-to-label, double-click terrain = create note, click empty = dismiss), hover states, and link arcs (drawn on selection only).

Key invariants:

- Positions are unit vectors `[x, y, z]`, sphere radius 1, y-up (matches Three.js).
- Files are truth: create/edit notes by writing files into `vault/` (or via `POST /api/items`, which writes a file) — never by editing DB rows directly.
- The embedding model (`MEMWORLD_MODEL`, default all-MiniLM-L6-v2) determines the vec table dimension; changing models requires deleting `vault/.memworld/index.db` so embeddings rebuild.

Config is env-based: `MEMWORLD_VAULT`, `MEMWORLD_DB`, `MEMWORLD_MODEL` (see `backend/src/memworld/config.py`).
