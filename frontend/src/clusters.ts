import * as THREE from 'three'
import type { WorldItem } from './api'

export interface Cluster {
  center: THREE.Vector3
  items: WorldItem[]
  label: string
  /** label before parent-prefix stripping (hierarchy levels use this) */
  origLabel?: string
}

function dominantTag(items: WorldItem[]): string | null {
  const counts = new Map<string, number>()
  for (const item of items) {
    for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = 1 // a tag must appear at least twice to define a region
  for (const [tag, count] of counts) {
    if (count > bestCount) {
      best = tag
      bestCount = count
    }
  }
  return best
}

/** Top LOD level: merge child regions that share a dominant tag into one
 * continent ("ART"), regardless of how far the topic sprawls — pure geometric
 * merging splits big domains. Untagged children join the nearest continent. */
export function computeSuperClusters(children: Cluster[]): Cluster[] {
  const byTag = new Map<string, Cluster[]>()
  const untagged: Cluster[] = []
  for (const child of children) {
    const tag = dominantTag(child.items)
    if (tag) {
      let group = byTag.get(tag)
      if (!group) byTag.set(tag, (group = []))
      group.push(child)
    } else {
      untagged.push(child)
    }
  }
  const fromGroup = (label: string, group: Cluster[]): Cluster => {
    const items = group.flatMap((c) => c.items)
    const center = group
      .reduce(
        (acc, c) => acc.addScaledVector(c.center, c.items.length),
        new THREE.Vector3(),
      )
      .normalize()
    return { center, items, label }
  }
  const supers = [...byTag.entries()].map(([tag, group]) =>
    fromGroup(titleCase(tag), group),
  )
  for (const child of untagged) {
    let best: Cluster | null = null
    let bestAngle = 0.85
    for (const s of supers) {
      const a = s.center.angleTo(child.center)
      if (a < bestAngle) {
        bestAngle = a
        best = s
      }
    }
    if (best) {
      best.items = best.items.concat(child.items)
    } else {
      supers.push({ center: child.center.clone(), items: child.items, label: child.label })
    }
  }
  disambiguate(supers)
  return supers
}

/** Children whose label repeats their parent region's name shed the prefix:
 * "ART · Artist" under "ART" becomes just "Artist". */
export function stripParentPrefixes(children: Cluster[], parents: Cluster[]): void {
  for (const child of children) {
    let parent: Cluster | null = null
    let best = Infinity
    for (const p of parents) {
      const a = p.center.angleTo(child.center)
      if (a < best) {
        best = a
        parent = p
      }
    }
    if (!parent) continue
    for (const prefix of [parent.label, parent.origLabel ?? parent.label]) {
      if (prefix && child.label.startsWith(`${prefix} · `)) {
        child.origLabel = child.label
        child.label = child.label.slice(prefix.length + 3)
        break
      }
    }
  }
}

/** Leader clustering on geodesic distance: items join the nearest cluster
 * CENTER within `radius`, so dense worlds can't chain into one mega-region
 * (single-linkage did exactly that). Two refinement passes settle centers.
 * Fine up to ~1k items; past that this moves to the backend. */
export function computeClusters(items: WorldItem[], radius = 0.6): Cluster[] {
  const dirs = items.map((i) => new THREE.Vector3(...i.pos))
  let centers: THREE.Vector3[] = []
  let assign: number[] = []
  for (let pass = 0; pass < 3; pass++) {
    assign = []
    const counts: number[] = pass === 0 ? [] : centers.map(() => 0)
    if (pass === 0) centers = []
    const sums = centers.map(() => new THREE.Vector3())
    for (let i = 0; i < dirs.length; i++) {
      let best = -1
      let bestAngle = radius
      for (let c = 0; c < centers.length; c++) {
        const a = dirs[i].angleTo(centers[c])
        if (a < bestAngle) {
          bestAngle = a
          best = c
        }
      }
      if (best === -1) {
        centers.push(dirs[i].clone())
        sums.push(dirs[i].clone())
        counts.push(1)
        best = centers.length - 1
      } else {
        sums[best].add(dirs[i])
        counts[best]++
      }
      assign.push(best)
    }
    centers = sums
      .map((s, c) => (counts[c] > 0 ? s.normalize() : centers[c]))
      .filter((_, c) => counts[c] > 0)
  }
  const groups = new Map<number, number[]>()
  for (let i = 0; i < assign.length; i++) {
    let g = groups.get(assign[i])
    if (!g) groups.set(assign[i], (g = []))
    g.push(i)
  }
  const result = [...groups.values()].map((idx) => {
    const members = idx.map((i) => items[i])
    const center = idx
      .reduce((acc, i) => acc.add(dirs[i]), new THREE.Vector3())
      .normalize()
    return { center, items: members, label: labelFor(members, center) }
  })
  disambiguate(result)
  return result
}

/** Two regions named "Art" reads as a bug — give duplicates a second tag or
 * their most central title as a qualifier. */
function disambiguate(clusters: Cluster[]): void {
  const byLabel = new Map<string, Cluster[]>()
  for (const c of clusters) {
    let g = byLabel.get(c.label)
    if (!g) byLabel.set(c.label, (g = []))
    g.push(c)
  }
  for (const [label, group] of byLabel) {
    if (group.length < 2) continue
    for (const c of group) {
      const counts = new Map<string, number>()
      for (const m of c.items) {
        for (const t of m.tags) {
          if (titleCase(t) !== label) counts.set(t, (counts.get(t) ?? 0) + 1)
        }
      }
      const second = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      if (second) {
        c.label = `${label} · ${titleCase(second)}`
      } else {
        const central = centralTitle(c)
        if (central && central !== label) c.label = `${label} · ${central}`
      }
    }
    // second tags can collide too (two art clusters, both mostly #artist) —
    // anything still duplicated falls back to its most central title
    const seen = new Set<string>()
    for (const c of group) {
      if (seen.has(c.label)) c.label = `${label} · ${centralTitle(c)}`
      seen.add(c.label)
    }
  }
}

function centralTitle(c: Cluster): string {
  let pick = c.items[0]
  let pickDist = Infinity
  for (const m of c.items) {
    const d = new THREE.Vector3(...m.pos).angleTo(c.center)
    if (d < pickDist) {
      pickDist = d
      pick = m
    }
  }
  const t = pick.title.replace(/_/g, ' ')
  return t.length > 18 ? t.slice(0, 17).trimEnd() + '…' : t
}

function titleCase(s: string): string {
  if (s.length <= 3) return s.toUpperCase() // acronym tags: ml -> ML
  return s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function labelFor(members: WorldItem[], center: THREE.Vector3): string {
  // prefer the dominant tag if it actually represents the cluster
  const counts = new Map<string, number>()
  for (const m of members) for (const t of m.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
  let best: string | null = null
  let bestCount = 0
  for (const [tag, count] of counts) {
    if (count > bestCount) {
      best = tag
      bestCount = count
    }
  }
  if (best && bestCount >= 2) return titleCase(best)
  // fallback: title of the most central member
  let pick = members[0]
  let pickDist = Infinity
  for (const m of members) {
    const d = new THREE.Vector3(...m.pos).angleTo(center)
    if (d < pickDist) {
      pickDist = d
      pick = m
    }
  }
  const title = pick.title.replace(/_/g, ' ')
  return title.length > 24 ? title.slice(0, 23).trimEnd() + '…' : title
}

export function makeClusterSprite(
  cluster: Cluster,
  elevation: number,
  sizeMul = 1,
): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 720
  canvas.height = 200
  const ctx = canvas.getContext('2d')!
  const text = cluster.label
  const countText = String(cluster.items.length)

  ctx.font = '600 58px Georgia, serif'
  const tw = ctx.measureText(text).width
  ctx.font = '400 40px Georgia, serif'
  const cw = ctx.measureText(countText).width
  const pad = 40
  const pillW = Math.min(688, tw + cw + pad * 2 + 34)
  const pillH = 108
  const x0 = (canvas.width - pillW) / 2
  const y0 = (canvas.height - pillH) / 2

  ctx.shadowColor = 'rgba(0,0,0,0.45)'
  ctx.shadowBlur = 22
  ctx.shadowOffsetY = 8
  ctx.fillStyle = 'rgba(24, 28, 38, 0.82)'
  ctx.beginPath()
  ctx.roundRect(x0, y0, pillW, pillH, pillH / 2)
  ctx.fill()
  ctx.shadowColor = 'transparent'
  ctx.strokeStyle = 'rgba(245, 238, 217, 0.55)'
  ctx.lineWidth = 3
  ctx.stroke()

  ctx.fillStyle = '#f5eed9'
  ctx.font = '600 58px Georgia, serif'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x0 + pad, canvas.height / 2 + 2, pillW - pad * 2 - cw - 30)
  ctx.fillStyle = 'rgba(245, 238, 217, 0.62)'
  ctx.font = '400 40px Georgia, serif'
  ctx.fillText(countText, x0 + pillW - pad - cw, canvas.height / 2 + 4)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  // no depth test: the quad would slice into the terrain at the horizon.
  // far-side labels are culled manually each frame instead (applyLod).
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const sprite = new THREE.Sprite(material)
  sprite.renderOrder = 20
  const w = (0.3 + Math.log2(cluster.items.length + 1) * 0.045) * sizeMul
  sprite.scale.set(w, w * (canvas.height / canvas.width), 1)
  sprite.position
    .copy(cluster.center)
    .multiplyScalar(1 + Math.max(0, elevation) + 0.11)
  sprite.userData.cluster = cluster
  return sprite
}

export function disposeSprite(sprite: THREE.Sprite): void {
  sprite.material.map?.dispose()
  sprite.material.dispose()
}
