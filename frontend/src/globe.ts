import * as THREE from 'three'
import type { WorldItem } from './api'

const DETAIL = 28 // icosphere subdivision; facet size sets the low-poly look
const KERNEL_SIGMA = 0.22 // radians; how far one item's "mass" spreads
const SEA_TAU = 0.35 // density where land breaks the surface
const HMAX = 0.045 // tallest peaks above sea level
const SEABED = -0.015
// the terrain is a density visualisation, not an index: past this many items
// the field is computed from a deterministic sample (shape is preserved)
const DENSITY_SAMPLE = 2500
const CUTOFF = 0.7 // radians; the gaussian kernel is nil beyond ~3 sigma
const COS_CUTOFF = Math.cos(CUTOFF)

// deterministic per-position jitter so duplicated (non-indexed) vertices at the
// same position displace identically and the mesh stays watertight
function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453
  return s - Math.floor(s)
}

// -- spatial bins: lat/lon grid so density queries only touch nearby items ----

const LON_BINS = 36
const LAT_BINS = 18
const BIN_COUNT = LON_BINS * LAT_BINS

function binIndex(x: number, y: number, z: number): number {
  const lat = Math.asin(THREE.MathUtils.clamp(y, -1, 1))
  const lon = Math.atan2(z, x)
  const row = Math.min(
    LAT_BINS - 1,
    Math.floor(((lat + Math.PI / 2) / Math.PI) * LAT_BINS),
  )
  const col =
    ((Math.floor(((lon + Math.PI) / (2 * Math.PI)) * LON_BINS) % LON_BINS) +
      LON_BINS) %
    LON_BINS
  return row * LON_BINS + col
}

/** For each bin, the bins whose contents could be within CUTOFF. Static. */
const BIN_NEIGHBORS: number[][] = (() => {
  const centers: THREE.Vector3[] = []
  for (let row = 0; row < LAT_BINS; row++) {
    for (let col = 0; col < LON_BINS; col++) {
      const lat = ((row + 0.5) / LAT_BINS) * Math.PI - Math.PI / 2
      const lon = ((col + 0.5) / LON_BINS) * 2 * Math.PI - Math.PI
      centers.push(
        new THREE.Vector3(
          Math.cos(lat) * Math.cos(lon),
          Math.sin(lat),
          Math.cos(lat) * Math.sin(lon),
        ),
      )
    }
  }
  const margin = 0.26 // bin "radius" with slack
  const lists: number[][] = []
  for (let a = 0; a < BIN_COUNT; a++) {
    const list: number[] = []
    for (let b = 0; b < BIN_COUNT; b++) {
      if (centers[a].angleTo(centers[b]) < CUTOFF + margin * 2) list.push(b)
    }
    lists.push(list)
  }
  return lists
})()

// -- terrain colours ------------------------------------------------------------

const BANDS: [number, THREE.Color][] = [
  [0.0, new THREE.Color('#b3a37c')], // seabed
  [0.002, new THREE.Color('#e8d89f')], // beach
  [0.01, new THREE.Color('#a3c172')], // meadow
  [0.02, new THREE.Color('#7fa75e')], // forest
  [0.03, new THREE.Color('#62894b')], // deep forest
  [0.038, new THREE.Color('#8c8474')], // rock
  [Infinity, new THREE.Color('#f2efe4')], // snow
]

function colorForHeight(h: number, out: THREE.Color): void {
  for (const [limit, color] of BANDS) {
    if (h <= limit) {
      out.copy(color)
      return
    }
  }
  out.copy(BANDS[BANDS.length - 1][1])
}

export class Globe {
  readonly group = new THREE.Group()
  readonly land: THREE.Mesh
  private tau = SEA_TAU // sea level rises with density so land stays ~1/3 of the surface
  // sampled item directions, binned for fast local density queries
  private fieldX = new Float32Array(0)
  private fieldY = new Float32Array(0)
  private fieldZ = new Float32Array(0)
  private bins: number[][] = []

  constructor() {
    const water = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 12),
      new THREE.MeshStandardMaterial({
        color: '#3d7ab5',
        flatShading: true,
        roughness: 0.45,
        metalness: 0.05,
        transparent: true,
        opacity: 0.94,
      }),
    )
    this.land = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        flatShading: true,
        roughness: 0.95,
        metalness: 0,
      }),
    )
    this.group.add(water, this.land)
    this.update([])
  }

  private setField(items: WorldItem[]): void {
    let sampled = items
    if (items.length > DENSITY_SAMPLE) {
      sampled = []
      const stride = items.length / DENSITY_SAMPLE
      for (let i = 0; i < DENSITY_SAMPLE; i++) sampled.push(items[Math.floor(i * stride)])
    }
    const n = sampled.length
    this.fieldX = new Float32Array(n)
    this.fieldY = new Float32Array(n)
    this.fieldZ = new Float32Array(n)
    this.bins = Array.from({ length: BIN_COUNT }, () => [])
    for (let i = 0; i < n; i++) {
      const [x, y, z] = sampled[i].pos
      this.fieldX[i] = x
      this.fieldY[i] = y
      this.fieldZ[i] = z
      this.bins[binIndex(x, y, z)].push(i)
    }
  }

  private densityAt(x: number, y: number, z: number): number {
    let d = 0
    const inv = 1 / (KERNEL_SIGMA * KERNEL_SIGMA)
    for (const bin of BIN_NEIGHBORS[binIndex(x, y, z)]) {
      for (const i of this.bins[bin]) {
        const dot = x * this.fieldX[i] + y * this.fieldY[i] + z * this.fieldZ[i]
        if (dot < COS_CUTOFF) continue
        const ang = Math.acos(dot > 1 ? 1 : dot)
        d += Math.exp(-ang * ang * inv)
      }
    }
    return d
  }

  elevation(p: THREE.Vector3): number {
    const d = this.densityAt(p.x, p.y, p.z)
    if (d <= this.tau) return SEABED * (1 - d / this.tau)
    return HMAX * Math.tanh((d - this.tau) * 1.1)
  }

  update(items: WorldItem[]): void {
    this.setField(items)
    const geometry = new THREE.IcosahedronGeometry(1, DETAIL).toNonIndexed()
    const pos = geometry.attributes.position as THREE.BufferAttribute
    const n = pos.count
    const heights = new Float32Array(n)
    const v = new THREE.Vector3()

    // adaptive sea level: at least SEA_TAU, else the density quantile that
    // keeps roughly a third of the world above water
    const densities = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, i).normalize()
      densities[i] = this.densityAt(v.x, v.y, v.z)
    }
    const sorted = Float32Array.from(densities).sort()
    this.tau = Math.max(SEA_TAU, sorted[Math.floor(n * 0.67)])

    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, i).normalize()
      const d = densities[i]
      let h =
        d <= this.tau
          ? SEABED * (1 - d / this.tau)
          : HMAX * Math.tanh((d - this.tau) * 1.1)
      // jaggedness on land only; coastline band stays smooth
      if (h > 0.001) h += (hash3(v.x, v.y, v.z) - 0.5) * Math.min(0.014, h)
      heights[i] = h
      pos.setXYZ(i, v.x * (1 + h), v.y * (1 + h), v.z * (1 + h))
    }
    // one color per face for crisp low-poly facets
    const colors = new Float32Array(n * 3)
    const c = new THREE.Color()
    for (let f = 0; f < n; f += 3) {
      const h = (heights[f] + heights[f + 1] + heights[f + 2]) / 3
      colorForHeight(h, c)
      for (let j = 0; j < 3; j++) {
        colors[(f + j) * 3] = c.r
        colors[(f + j) * 3 + 1] = c.g
        colors[(f + j) * 3 + 2] = c.b
      }
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geometry.computeVertexNormals()
    this.land.geometry.dispose()
    this.land.geometry = geometry
  }
}
