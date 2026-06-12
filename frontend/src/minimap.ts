import * as THREE from 'three'
import type { WorldItem } from './api'

const W = 260
const H = 130
const DPR = 2

const KIND_DOT: Record<string, string> = {
  note: '#a8c97e',
  pdf: '#d98a66',
  image: '#7fa3d6',
}

function toXY(x: number, y: number, z: number): [number, number] {
  const lon = Math.atan2(z, x)
  const lat = Math.asin(THREE.MathUtils.clamp(y, -1, 1))
  return [((lon + Math.PI) / (2 * Math.PI)) * W, (1 - (lat + Math.PI / 2) / Math.PI) * H]
}

/** Bottom-left overview: the whole world flattened to an equirect map.
 * Click to centre that point on the globe. */
export class Minimap {
  private base = document.createElement('canvas')
  private ctx: CanvasRenderingContext2D

  constructor(canvas: HTMLCanvasElement, onPick: (dir: THREE.Vector3) => void) {
    canvas.width = W * DPR
    canvas.height = H * DPR
    this.base.width = W * DPR
    this.base.height = H * DPR
    this.ctx = canvas.getContext('2d')!
    this.ctx.scale(DPR, DPR)
    this.setWorld([])
    canvas.addEventListener('click', (e) => {
      const r = canvas.getBoundingClientRect()
      const mx = ((e.clientX - r.left) / r.width) * W
      const my = ((e.clientY - r.top) / r.height) * H
      const lon = (mx / W) * 2 * Math.PI - Math.PI
      const lat = (1 - my / H) * Math.PI - Math.PI / 2
      onPick(
        new THREE.Vector3(
          Math.cos(lat) * Math.cos(lon),
          Math.sin(lat),
          Math.cos(lat) * Math.sin(lon),
        ),
      )
    })
  }

  /** Re-render the static layer: ocean, density blobs, item dots. */
  setWorld(items: WorldItem[]): void {
    const ctx = this.base.getContext('2d')!
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#23405e'
    ctx.fillRect(0, 0, W, H)
    // faint graticule
    ctx.strokeStyle = 'rgba(245, 238, 217, 0.07)'
    ctx.lineWidth = 1
    for (let i = 1; i < 6; i++) {
      ctx.beginPath()
      ctx.moveTo((i / 6) * W, 0)
      ctx.lineTo((i / 6) * W, H)
      ctx.stroke()
    }
    ctx.beginPath()
    ctx.moveTo(0, H / 2)
    ctx.lineTo(W, H / 2)
    ctx.stroke()
    // land blobs (drawn thrice for date-line wrap)
    for (const item of items) {
      const [x, y] = toXY(...item.pos)
      for (const dx of [-W, 0, W]) {
        const g = ctx.createRadialGradient(x + dx, y, 0, x + dx, y, 11)
        g.addColorStop(0, 'rgba(150, 165, 105, 0.5)')
        g.addColorStop(1, 'rgba(150, 165, 105, 0)')
        ctx.fillStyle = g
        ctx.fillRect(x + dx - 11, y - 11, 22, 22)
      }
    }
    // item dots
    for (const item of items) {
      const [x, y] = toXY(...item.pos)
      ctx.fillStyle = KIND_DOT[item.kind] ?? '#ddd'
      ctx.beginPath()
      ctx.arc(x, y, 1.6, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  /** Per-frame: static layer + the current view marker. */
  draw(target: THREE.Vector3): void {
    const ctx = this.ctx
    ctx.clearRect(0, 0, W, H)
    ctx.drawImage(this.base, 0, 0, W, H)
    const [x, y] = toXY(target.x, target.y, target.z)
    ctx.strokeStyle = '#f5eed9'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(x, y, 5, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = '#f5eed9'
    ctx.beginPath()
    ctx.arc(x, y, 1.5, 0, Math.PI * 2)
    ctx.fill()
  }
}
