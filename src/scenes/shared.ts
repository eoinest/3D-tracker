import {
  BufferGeometry,
  CanvasTexture,
  Color,
  Material,
  Mesh,
  type Object3D,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
} from 'three'

/** Procedural grid texture — keeps the repo asset-free and loads instantly. */
export function makeGridTexture(options: {
  size?: number
  background?: string
  line?: string
  accent?: string
  divisions?: number
} = {}): CanvasTexture {
  const {
    size = 512,
    background = '#0d1117',
    line = '#243040',
    accent = '#3d5a80',
    divisions = 8,
  } = options

  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = background
  ctx.fillRect(0, 0, size, size)

  const step = size / divisions
  ctx.strokeStyle = line
  ctx.lineWidth = Math.max(1, size / 512)
  ctx.beginPath()
  for (let i = 1; i < divisions; i++) {
    const p = Math.round(i * step) + 0.5
    ctx.moveTo(p, 0)
    ctx.lineTo(p, size)
    ctx.moveTo(0, p)
    ctx.lineTo(size, p)
  }
  ctx.stroke()

  ctx.strokeStyle = accent
  ctx.lineWidth = Math.max(2, size / 170)
  ctx.strokeRect(0, 0, size, size)

  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.wrapS = texture.wrapT = RepeatWrapping
  texture.anisotropy = 8
  return texture
}

/** Vertical gradient, used as a cheap sky/backdrop. */
export function makeSkyTexture(
  stops: [number, string][] = [
    [0, '#101c30'],
    [0.55, '#0a1120'],
    [1, '#05070c'],
  ],
): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 4
  canvas.height = 256
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height)
  for (const [offset, color] of stops) gradient.addColorStop(offset, color)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}

/** Soft round sprite, for point clouds. */
export function makeDotTexture(size = 64): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.35, 'rgba(255,255,255,0.75)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}

/** Deterministic PRNG so a scene looks the same every time you open it. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const PALETTE: readonly Color[] = [
  new Color('#4cc9f0'),
  new Color('#f72585'),
  new Color('#b5179e'),
  new Color('#7209b7'),
  new Color('#4361ee'),
  new Color('#4ad66d'),
  new Color('#ffd166'),
]

export function paletteColor(i: number): Color {
  return PALETTE[Math.abs(i) % PALETTE.length]!
}

/** Recursively release GPU memory for a subtree. */
export function disposeObject(root: Object3D): void {
  const textures = new Set<Texture>()
  root.traverse((obj) => {
    const mesh = obj as Partial<Mesh>
    const geometry = mesh.geometry as BufferGeometry | undefined
    geometry?.dispose()

    const material = mesh.material
    if (!material) return
    for (const m of Array.isArray(material) ? material : [material]) {
      for (const value of Object.values(m as unknown as Record<string, unknown>)) {
        if (value instanceof Texture) textures.add(value)
      }
      ;(m as Material).dispose()
    }
  })
  for (const t of textures) t.dispose()
}
