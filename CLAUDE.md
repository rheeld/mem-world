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
- **`frontend/src/`** — Three.js, no framework. The terrain is generated geometry, not an asset: `globe.ts` evaluates a gaussian density field over item positions at every vertex of a non-indexed icosphere, displacing dense regions up out of a low-poly water sphere (flat shading, one color band per face by height). Sea level is **adaptive** — a density quantile keeps land ≈1/3 of the surface as the world fills, so the ocean never drowns. `Globe.elevation()` is the single source of truth for terrain height — cards, arcs, cluster labels, and the camera floor all sample it. `controls.ts` is a custom Google-Earth-style camera (`GlobeControls`): the camera targets a point ON the surface; the tangent frame is **parallel-transported** with the target (never derived from a world axis — that's what made panning jump at the poles); left-drag pans with true grab-the-ground speed as a pure tangent-plane TRANSLATION of the target (never a rotation around camera axes — that spins the view when looking straight down and reads as shake; pan signs were verified empirically), wheel zooms, holding right/middle mouse tilts/orbits around the current focus; all motion eases through smoothed state (`viewDistance` exposes the smoothed zoom for LOD). Cards are `THREE.Sprite`s (screen-aligned billboards anchored at a bottom-center pin notch) so they never perspective-skew; arcs are `TubeGeometry` meshes (hoverable, click to ride to the far end). `minimap.ts` renders a 2D equirect overview (bottom-left) with click-to-centre. Zoom LOD lives in `main.ts` (`LABEL_LEVELS` + `applyLod`): a configurable hierarchy of label levels, each with its own clustering radius, fade band, and click-descend distance — currently continents → regions → fine clusters → cards. Mid/fine levels are geometric (`clusters.ts` leader clustering — single-linkage chained the whole world into one region); the TOP level is semantic (`computeSuperClusters` merges regions sharing a dominant tag, because pure geometry splits sprawling domains like art into several "ART" labels). Children shed their parent's label prefix ("ART · Artist" → "Artist"). Clicking a label descends exactly one level; the deepest level also opens the region panel. Add levels to `LABEL_LEVELS` as density grows. `ui.ts` owns the side panel: markdown view/edit/delete for notes (writes back through the API to vault files), a lazy pdf.js reader for PDFs (the on-terrain scroll-strip from DESIGN.md is not built yet), and full-size image view. Image items (`.png/.jpg/...`) carry no extracted text — the FILENAME is the semantics (name artwork files `artist-name-work-title.jpg` so they land near their artist). `scene.ts` has stars/atmosphere/lights. `main.ts` owns the scene graph, polling, raycasting (click = select or fly-to-label, double-click terrain = create note, click empty = dismiss), hover states, and link arcs (drawn on selection only).

Key invariants:

- Positions are unit vectors `[x, y, z]`, sphere radius 1, y-up (matches Three.js).
- Files are truth: create/edit notes by writing files into `vault/` (or via `POST /api/items`, which writes a file) — never by editing DB rows directly.
- The embedding model (`MEMWORLD_MODEL`, default all-MiniLM-L6-v2) determines the vec table dimension; changing models requires deleting `vault/.memworld/index.db` so embeddings rebuild.

Config is env-based: `MEMWORLD_VAULT`, `MEMWORLD_DB`, `MEMWORLD_MODEL` (see `backend/src/memworld/config.py`).
