import * as THREE from 'three'
import type { WorldItem } from './api'

const DETAIL = 28 // icosphere subdivision; facet size sets the low-poly look
const KERNEL_SIGMA = 0.22 // radians; how far one item's "mass" spreads
const SEA_TAU = 0.35 // density where land breaks the surface
const HMAX = 0.045 // tallest peaks above sea level
const SEABED = -0.015

// deterministic per-position jitter so duplicated (non-indexed) vertices at the
// same position displace identically and the mesh stays watertight
function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453
  return s - Math.floor(s)
}

export function densityAt(p: THREE.Vector3, items: WorldItem[]): number {
  let d = 0
  for (const item of items) {
    const dot = THREE.MathUtils.clamp(
      p.x * item.pos[0] + p.y * item.pos[1] + p.z * item.pos[2],
      -1,
      1,
    )
    const ang = Math.acos(dot)
    d += Math.exp(-(ang * ang) / (KERNEL_SIGMA * KERNEL_SIGMA))
  }
  return d
}

export function elevationAt(
  p: THREE.Vector3,
  items: WorldItem[],
  tau = SEA_TAU,
): number {
  const d = densityAt(p, items)
  if (d <= tau) return SEABED * (1 - d / tau)
  return HMAX * Math.tanh((d - tau) * 1.1)
}

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
  private items: WorldItem[] = []
  private tau = SEA_TAU // sea level rises with density so land stays ~1/3 of the surface

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

  elevation(p: THREE.Vector3): number {
    return elevationAt(p, this.items, this.tau)
  }

  update(items: WorldItem[]): void {
    this.items = items
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
      densities[i] = densityAt(v, items)
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
