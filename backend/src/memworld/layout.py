from __future__ import annotations

import logging

import numpy as np

log = logging.getLogger("memworld.layout")

# below this many items, spherical UMAP is unstable — use greedy placement
UMAP_MIN_ITEMS = 12


def _normalize(p: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(p, axis=-1, keepdims=True)
    n[n == 0] = 1.0
    return p / n


def full_layout(
    vecs: np.ndarray,
    pinned: dict[int, np.ndarray] | None = None,
    seed: int = 42,
) -> np.ndarray:
    """Map (n, dim) unit embeddings to (n, 3) unit vectors on the sphere.

    pinned maps row index -> fixed position; pinned rows are never moved.
    """
    n = len(vecs)
    pinned = pinned or {}
    if n == 0:
        return np.zeros((0, 3), dtype=np.float64)
    if n == 1:
        return _normalize(np.array([[0.3, 0.45, 0.85]]))

    pos = None
    if n >= UMAP_MIN_ITEMS:
        pos = _umap_sphere(vecs, seed)
    if pos is None:
        pos = _greedy_layout(vecs, seed)

    pinned_mask = np.zeros(n, dtype=bool)
    for i, p in pinned.items():
        pos[i] = _normalize(np.asarray(p, dtype=np.float64))
        pinned_mask[i] = True

    return settle(pos, vecs, pinned_mask)


def _umap_sphere(vecs: np.ndarray, seed: int) -> np.ndarray | None:
    """Spherical UMAP: 2D embedding with haversine output metric -> unit sphere."""
    try:
        import umap

        nn = int(min(15, max(2, len(vecs) - 1)))
        reducer = umap.UMAP(
            n_components=2,
            metric="cosine",
            output_metric="haversine",
            n_neighbors=nn,
            min_dist=0.4,
            random_state=seed,
        )
        emb = reducer.fit_transform(vecs)
    except Exception:
        log.exception("spherical UMAP failed; falling back to greedy layout")
        return None
    theta, phi = emb[:, 0], emb[:, 1]
    # y-up to match the Three.js frontend
    return np.stack(
        [np.sin(theta) * np.cos(phi), np.cos(theta), np.sin(theta) * np.sin(phi)],
        axis=1,
    )


def _greedy_layout(vecs: np.ndarray, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = len(vecs)
    pos = np.zeros((n, 3), dtype=np.float64)
    pos[0] = _normalize(rng.normal(size=3))
    for i in range(1, n):
        pos[i] = place_near(vecs[:i], pos[:i], vecs[i], rng=rng)
    return pos


def place_near(
    vecs: np.ndarray,
    pos: np.ndarray,
    v: np.ndarray,
    rng: np.random.Generator | None = None,
    k: int = 8,
    sharpness: float = 6.0,
    jitter: float = 0.06,
) -> np.ndarray:
    """Place a new item at the similarity-weighted centroid of its kNN, with tangent jitter."""
    rng = rng if rng is not None else np.random.default_rng(7)
    sims = vecs @ v
    k = min(k, len(vecs))
    idx = np.argsort(-sims)[:k]
    w = np.exp((sims[idx] - sims[idx].max()) * sharpness)
    w /= w.sum()
    p = (pos[idx] * w[:, None]).sum(axis=0)
    if np.linalg.norm(p) < 1e-3:  # near-antipodal degenerate centroid
        p = rng.normal(size=3)
    p = _normalize(p)
    t = rng.normal(size=3)
    t -= (t @ p) * p
    tn = np.linalg.norm(t)
    if tn > 1e-9:
        p = p + (t / tn) * jitter
    return _normalize(p)


def settle(
    pos: np.ndarray,
    vecs: np.ndarray,
    pinned_mask: np.ndarray | None = None,
    steps: int = 150,
    attract: float = 0.3,
    sim_floor: float = 0.30,
    repel: float = 0.004,
    max_step: float = 0.04,
) -> np.ndarray:
    """Force relaxation on the sphere. Attraction acts only on kNN pairs whose
    cosine similarity clears sim_floor (raw cosines are always positive, so
    without the floor the whole world collapses into one clump). Inverse-square
    repulsion between all pairs spreads clusters over the sphere and doubles as
    collision avoidance."""
    n = len(pos)
    pos = _normalize(np.asarray(pos, dtype=np.float64))
    if n < 3:
        return pos
    if pinned_mask is None:
        pinned_mask = np.zeros(n, dtype=bool)

    sims = vecs @ vecs.T
    k = min(6, n - 1)
    nbr = np.argsort(-sims, axis=1)[:, 1 : k + 1]
    nbr_w = np.clip(np.take_along_axis(sims, nbr, axis=1) - sim_floor, 0.0, None)

    # exact pairwise repulsion is O(n^2); past this it would need a spatial index
    exact_repel = n <= 2500

    for _ in range(steps):
        force = ((pos[nbr] - pos[:, None, :]) * nbr_w[..., None]).sum(axis=1) * attract
        if exact_repel:
            diff = pos[:, None, :] - pos[None, :, :]
            dist = np.linalg.norm(diff, axis=-1)
            np.fill_diagonal(dist, 1e9)
            force += ((diff / dist[..., None]) / (dist**2 + 1e-4)[..., None]).sum(
                axis=1
            ) * repel
        # clamp per-item displacement for stability
        mag = np.linalg.norm(force, axis=1, keepdims=True)
        force *= np.minimum(1.0, max_step / np.maximum(mag, 1e-12))
        force[pinned_mask] = 0.0
        pos = _normalize(pos + force)
    return pos
