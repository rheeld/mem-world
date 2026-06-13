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

- **`vault/`** — drop directory of `.md`/`.pdf`/image files; the content source of truth. All derived data (positions, embeddings, links, tags, per-item terrain `weight`, rev counter) lives in SQLite + sqlite-vec at `vault/.memworld/index.db`. Deleting the DB is safe — it rebuilds from files — but item positions, pins, and weights are lost (a fresh layout regenerates them). `vault/` itself is gitignored (personal content); `vault/wiki/` is the Wikipedia import (see scripts below).
- **`backend/src/memworld/`** — FastAPI. `world.py` is the orchestrator: a single `World` instance guarded by an RLock; every mutation bumps a `rev` counter that the frontend polls (`GET /api/world?since=rev`). `scan()` parses + embeds OUTSIDE the lock and embeds in batches — a bulk import (9k Wikipedia articles) must not block the API for minutes; only the DB writes + layout take the lock. `vault.py` parses files (wikilinks, tags, PDF text via pypdf, images by filename) and watches the drop dir (watchdog → debounced full rescan; rescans are cheap because ingest is content-hash-gated). `embeddings.py` runs a local sentence-transformers model (must stay cross-platform: macOS dev machine + Linux/Windows Strix Halo box — no MLX/Metal-only deps). `layout.py` maps embeddings to **unit vectors on the unit sphere**: spherical UMAP (haversine output metric) for ≥12 items, greedy kNN placement for small worlds and incremental arrivals. **UMAP output is used as-is** — the old force-`settle` smeared global structure with long-range repulsion and now only de-overlaps the greedy fallback. A collision-only **`_declutter`** (heavily damped, short-range push-apart via scipy cKDTree) enforces minimum card spacing after UMAP so cards never overlap and flight paths stay legible. Because declutter equalises spacing (which flattens terrain), `_density_weights` records each item's PRE-declutter neighbourhood crowding as a 0.5–4× `weight` that drives terrain height. `settle` forces are normalised to a constant total per item (an unnormalised sum grows with item count and at ~10k overwhelms attraction). Items with `pinned=1` are never moved. The 3-min drift tick is skipped past 4k items.
- **`frontend/src/`** — Three.js, no framework.
  - `globe.ts` — terrain is generated geometry, not an asset: a **weighted** gaussian density field over item positions (each item's `weight` multiplies its kernel, so terrain peaks reflect PRE-declutter crowding, not the equalised card spacing) sampled at every vertex of a non-indexed icosphere, displacing dense regions up out of a low-poly water sphere (flat shading, one colour band per face by height). Sea level is **adaptive** — a density quantile keeps land ≈⅓ of the surface as the world fills. The field is computed from a deterministic 2.5k sample + lat/lon spatial bins so vertex evaluation stays fast at any item count. `Globe.elevation()` is the single source of truth for terrain height — cards, arcs, cluster labels, and the camera floor all sample it. The water sphere sits fractionally below sea level to avoid coastline z-fighting.
  - `controls.ts` — `GlobeControls`, a custom Google-Earth-style camera. Targets a point ON the surface; the tangent frame is **parallel-transported** with the target (never derived from a world axis — that made panning jump at the poles). Left-drag pans with true grab-the-ground speed as a pure tangent-plane TRANSLATION of the target (never a rotation around camera axes — that spins the view when looking straight down and reads as shake; **pan signs were verified empirically, do not "fix" them from first principles**). Wheel zooms; holding right/middle mouse tilts/orbits around the current focus. All motion eases through smoothed state (`viewDistance` exposes smoothed zoom for LOD). `ignorePointer` lets `main.ts` claim a gesture (context menu, card move). `minDistance`/`camera.near` shrink with world density — see card scaling below.
  - **Cards** are `THREE.Sprite`s (screen-aligned billboards anchored at a bottom-centre pin notch) so they never perspective-skew. There is no per-card depth test (terrain would slice them); the planet's occlusion is faked with a single **horizon clipping plane** updated each frame, so cards rise smoothly over the limb instead of popping. The renderer uses a **logarithmic depth buffer** (the density-scaled near plane otherwise z-fights). A **lazy card pool** keeps only ~350 cards near the camera target alive (10k canvas sprites would exhaust GPU memory); they respawn as the view moves. Card size scales with world density (≈1/√n) and `minDistance` scales with it, so ground-level on-screen size is constant while gaps between cards stay open — equivalent to growing the world without rescaling stored positions.
  - **Arcs** are `TubeGeometry` meshes (hoverable, click to ride to the far end), drawn on selection only.
  - **Zoom LOD** (`main.ts` `LABEL_LEVELS` + `applyLod`): a config-driven hierarchy — each level has a clustering radius, fade band, sprite size, click-descend distance — currently continents → regions → fine clusters → cards. TRULY NESTED: mid level is geometric (`clusters.ts` leader clustering — single-linkage chained the whole world into one region); top level is semantic (`computeSuperClusters` merges regions sharing a dominant tag, because pure geometry splits sprawling domains like art into several labels); fine level is computed INSIDE each mid region (`subdivide`) so children are true subsets. Naming is all derived, nothing manual: a child may not be named by any ancestor's tag, a tag ubiquitous (≥60%) in its parent, or a `GENERIC_TAGS` source marker like `wikipedia`; if several siblings claim the same tag it distinguishes nothing so they all fall back to central-item titles; a child identical to its parent inherits its label; singletons get no label. Fine clusters carry accent colours — member cards tint toward them while fine labels show, so groupings stay trackable through the zoom. Clicking a label descends one level; the deepest opens the region panel.
  - `minimap.ts` — 2D equirect overview (bottom-left), **wheel-zoomable** with its own LOD (continent summaries when out, item dots, then titles); click to centre that point on the globe.
  - `ui.ts` — the side panel (markdown view/edit/delete writing back to vault files, lazy pdf.js reader, full-size image view) and the region panel. Floating-card styling shared with the sidebar.
  - `main.ts` — scene graph, polling, raycasting, hover, the lazy card pool, the hamburger **sidebar** (world stats + hierarchical vault file tree + controls cheat-sheet), the floating HUD (search, +note, ☆views bookmarks in localStorage), file drag-&-drop upload, and the **card context menu** (right-click a card → open / move / pin; move mode follows the cursor, click to place, Esc cancels — left-drag never moves a card, that was too easy to trigger by accident).
  - Image items (`.png/.jpg/...`) carry no extracted text — the FILENAME is the semantics (name artwork files `artist-name-work-title.jpg` so they land near their artist).

## `scripts/`

- `fetch_wikipedia_vital.py` — imports Wikipedia's ~9k level-4 Vital Articles into `vault/wiki/<topic>/` as tagged markdown (topic tags drive the continents). Resumable and globally throttled (~3 req/s, hard backoff on HTTP 429); run with the backend venv python. This is the Phase-1 scale test (see DESIGN.md). Re-running skips already-fetched articles.

To force a full re-layout (e.g. after changing layout/weight logic): `sqlite3 vault/.memworld/index.db "UPDATE items SET x=NULL,y=NULL,z=NULL WHERE pinned=0"` then restart the backend — `scan()` re-lays-out any null-position items even when no files changed.

## Key invariants

- Positions are unit vectors `[x, y, z]`, sphere radius 1, y-up (matches Three.js).
- Files are truth: create/edit notes by writing files into `vault/` (or via `POST /api/items` / `POST /api/upload`, which write files) — never by editing DB rows directly.
- The embedding model (`MEMWORLD_MODEL`, default all-MiniLM-L6-v2) determines the vec table dimension; changing models requires deleting `vault/.memworld/index.db` so embeddings rebuild.
- Layout/clustering math runs at ~10k items today (Phase 1). Phase 2 (100k+) needs an ANN index, viewport tile streaming, and backend-side clustering — designed in DESIGN.md, not built. When touching layout or clustering, keep the O(n²) paths bounded (block-wise kNN, sampled repulsion, lazy card pool already do this).

Config is env-based: `MEMWORLD_VAULT`, `MEMWORLD_DB`, `MEMWORLD_MODEL` (see `backend/src/memworld/config.py`).
