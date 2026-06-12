import * as THREE from 'three'
import { fileUrl, type WorldItem } from './api'

const CARD_W = 0.1
const CANVAS_W = 560
const CANVAS_H = 372
const CARD_H = CARD_W * (CANVAS_H / CANVAS_W)
const MARGIN = 24 // transparent margin so the baked shadow isn't clipped

const KIND_COLOR: Record<string, string> = {
  note: '#7fa75e',
  pdf: '#c46a4a',
  image: '#5a7fb5',
}
const KIND_GLYPH: Record<string, string> = { note: '¶', pdf: '⎘', image: '✦' }

const sharedGeometry = new THREE.PlaneGeometry(CARD_W, CARD_H)

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
): void {
  const words = text.split(/\s+/)
  let line = ''
  let lines = 0
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines++
      if (lines === maxLines) {
        ctx.fillText(line + '…', x, y)
        return
      }
      ctx.fillText(line, x, y)
      y += lineHeight
      line = word
    } else {
      line = candidate
    }
  }
  if (line) ctx.fillText(line, x, y)
}

function cardFrame(ctx: CanvasRenderingContext2D): void {
  const w = CANVAS_W - MARGIN * 2
  const h = CANVAS_H - MARGIN * 2
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H)
  ctx.shadowColor = 'rgba(10, 14, 24, 0.4)'
  ctx.shadowBlur = 18
  ctx.shadowOffsetY = 10
  ctx.fillStyle = '#faf3e0'
  ctx.beginPath()
  ctx.roundRect(MARGIN, MARGIN, w, h, 18)
  ctx.fill()
  ctx.shadowColor = 'transparent'
}

function drawCard(ctx: CanvasRenderingContext2D, item: WorldItem): void {
  const w = CANVAS_W - MARGIN * 2
  cardFrame(ctx)
  ctx.strokeStyle = '#54442f'
  ctx.lineWidth = 4
  ctx.stroke()

  // kind ribbon
  const kindColor = KIND_COLOR[item.kind] ?? '#8a7350'
  ctx.fillStyle = kindColor
  ctx.beginPath()
  ctx.roundRect(MARGIN, MARGIN, w, 14, { tl: 18, tr: 18, br: 0, bl: 0 } as never)
  ctx.fill()

  // glyph badge
  ctx.fillStyle = kindColor
  ctx.beginPath()
  ctx.arc(CANVAS_W - MARGIN - 52, MARGIN + 64, 30, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#faf3e0'
  ctx.font = '36px Georgia, serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(KIND_GLYPH[item.kind] ?? '·', CANVAS_W - MARGIN - 52, MARGIN + 66)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'

  // title
  ctx.fillStyle = '#3a2f20'
  ctx.font = 'bold 44px Georgia, serif'
  wrapText(ctx, item.title, MARGIN + 30, MARGIN + 86, w - 150, 52, 3)

  // tags
  if (item.tags.length > 0) {
    ctx.font = 'italic 27px Georgia, serif'
    let x = MARGIN + 30
    const y = CANVAS_H - MARGIN - 30
    for (const tag of item.tags.slice(0, 4)) {
      const label = `#${tag}`
      const tw = ctx.measureText(label).width
      if (x + tw > CANVAS_W - MARGIN - 30) break
      ctx.fillStyle = 'rgba(122, 103, 72, 0.16)'
      ctx.beginPath()
      ctx.roundRect(x - 10, y - 26, tw + 20, 38, 19)
      ctx.fill()
      ctx.fillStyle = '#7a6748'
      ctx.fillText(label, x, y)
      x += tw + 34
    }
  }
  if (item.pinned) {
    ctx.fillStyle = '#8a7350'
    ctx.font = '30px Georgia, serif'
    ctx.fillText('⚲', CANVAS_W - MARGIN - 64, CANVAS_H - MARGIN - 28)
  }
}

/** Repaint the card as a framed artwork once its image loads. */
function drawImageCard(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  item: WorldItem,
): void {
  const w = CANVAS_W - MARGIN * 2
  const h = CANVAS_H - MARGIN * 2
  cardFrame(ctx)
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(MARGIN + 8, MARGIN + 8, w - 16, h - 16, 12)
  ctx.clip()
  // cover-fit the artwork
  const scale = Math.max((w - 16) / img.width, (h - 16) / img.height)
  const dw = img.width * scale
  const dh = img.height * scale
  ctx.drawImage(img, MARGIN + 8 + (w - 16 - dw) / 2, MARGIN + 8 + (h - 16 - dh) / 2, dw, dh)
  // title band
  const grad = ctx.createLinearGradient(0, CANVAS_H - MARGIN - 96, 0, CANVAS_H - MARGIN)
  grad.addColorStop(0, 'rgba(20, 16, 10, 0)')
  grad.addColorStop(1, 'rgba(20, 16, 10, 0.78)')
  ctx.fillStyle = grad
  ctx.fillRect(MARGIN + 8, CANVAS_H - MARGIN - 96, w - 16, 88)
  ctx.fillStyle = '#f5eed9'
  ctx.font = 'bold 34px Georgia, serif'
  wrapText(ctx, item.title, MARGIN + 26, CANVAS_H - MARGIN - 34, w - 60, 38, 1)
  ctx.restore()
  ctx.strokeStyle = '#54442f'
  ctx.lineWidth = 4
  ctx.beginPath()
  ctx.roundRect(MARGIN, MARGIN, w, h, 18)
  ctx.stroke()
}

export function makeCard(item: WorldItem, elevation = 0): THREE.Mesh {
  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_W
  canvas.height = CANVAS_H
  const ctx = canvas.getContext('2d')!
  drawCard(ctx, item)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 8
  if (item.kind === 'image') {
    const img = new Image()
    img.onload = () => {
      drawImageCard(ctx, img, item)
      texture.needsUpdate = true
    }
    img.src = fileUrl(item.id)
  }
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true })
  const mesh = new THREE.Mesh(sharedGeometry, material)
  const p = new THREE.Vector3(...item.pos).normalize()
  mesh.position.copy(p).multiplyScalar(1 + Math.max(0, elevation) + 0.016)
  mesh.userData.item = item
  mesh.userData.normal = p // cards are re-oriented every frame to stay readable
  return mesh
}

export function disposeCard(mesh: THREE.Mesh): void {
  const material = mesh.material as THREE.MeshBasicMaterial
  material.map?.dispose()
  material.dispose()
}
