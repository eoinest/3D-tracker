import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Points,
  PointsMaterial,
} from 'three'

import { disposeObject, makeDotTexture, mulberry32, paletteColor } from './shared'
import type { SceneContext, SceneDefinition, SceneInstance } from './types'

/**
 * Points scattered through a deep volume behind the screen.
 *
 * Nothing but parallax carries the depth here — no occlusion, no shading, no
 * foreshortening of familiar objects. If the illusion holds in this scene, the
 * head tracking is doing real work.
 */
export const starfieldScene: SceneDefinition = {
  id: 'starfield',
  name: 'Star Field',
  description: 'Pure parallax: depth from motion alone, with no other cues.',
  kind: 'world',
  create: createStarfield,
}

/** Assumed viewing distance; only used to spread stars across the frustum. */
const VIEW_DISTANCE_M = 0.55

interface Layer {
  count: number
  /** Depth range as a multiple of room depth. */
  nearDepth: number
  farDepth: number
  size: number
  attenuate: boolean
  brightness: number
  seed: number
}

/**
 * Two layers, because a single PointsMaterial has a single size.
 *
 * Distant stars need a fixed pixel size or they vanish below one pixel; near
 * dust needs true size attenuation so it looms and streaks past as you move.
 * One layer can't do both, and doing neither is what makes most naive star
 * fields read as flat noise.
 */
const LAYERS: Layer[] = [
  { count: 3400, nearDepth: 3, farDepth: 45, size: 2.2, attenuate: false, brightness: 1, seed: 0xc0ffee },
  { count: 420, nearDepth: 0.12, farDepth: 3, size: 0.022, attenuate: true, brightness: 1, seed: 0xbadf00d },
]

function createStarfield(ctx: SceneContext): SceneInstance {
  const root = new Group()
  root.name = 'starfield'

  const layers = LAYERS.map((layer) => buildLayer(layer))
  for (const { points } of layers) root.add(points)

  const layout = (c: SceneContext): void => {
    for (const layer of layers) layer.place(c)
  }
  layout(ctx)

  let drift = 0

  return {
    root,
    resize: layout,
    update(dt) {
      // A slow tumble keeps the field from looking frozen when you sit still,
      // without adding enough motion to compete with the head parallax.
      drift += dt * 0.02
      root.rotation.z = Math.sin(drift) * 0.015
      root.position.x = Math.sin(drift * 0.7) * 0.008
    },
    dispose() {
      disposeObject(root)
    },
  }
}

function buildLayer(layer: Layer): { points: Points; place(ctx: SceneContext): void } {
  const { count, nearDepth, farDepth, size, attenuate, brightness, seed } = layer

  const rand = mulberry32(seed)
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const seeds = new Float32Array(count * 3)
  const tint = new Color()
  const white = new Color(0xffffff)

  for (let i = 0; i < count; i++) {
    seeds[i * 3] = rand() - 0.5
    seeds[i * 3 + 1] = rand() - 0.5
    // Cube-root bias spreads stars evenly through the *volume* rather than
    // piling them all up against the near plane.
    seeds[i * 3 + 2] = Math.cbrt(rand())

    const shade = 0.45 + rand() * 0.55
    tint
      .copy(paletteColor(Math.floor(rand() * 7)))
      .lerp(white, 0.65)
      .multiplyScalar(shade * brightness)
    colors[i * 3] = tint.r
    colors[i * 3 + 1] = tint.g
    colors[i * 3 + 2] = tint.b
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('color', new BufferAttribute(colors, 3))

  const material = new PointsMaterial({
    size,
    sizeAttenuation: attenuate,
    map: makeDotTexture(),
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    toneMapped: false,
  })

  const points = new Points(geometry, material)
  points.frustumCulled = false

  const place = (ctx: SceneContext): void => {
    const near = ctx.roomDepthM * nearDepth
    // Never scatter stars past the far plane — turning the depth slider up
    // would otherwise quietly clip away most of the field.
    const far = Math.max(near * 1.5, Math.min(ctx.roomDepthM * farDepth, ctx.settings.farM * 0.9))

    for (let i = 0; i < count; i++) {
      const depth = near + seeds[i * 3 + 2]! * (far - near)
      // Spread each star across the frustum *at its own depth*, so the field
      // fills the window instead of tapering to a clump around the axis.
      const magnification = (VIEW_DISTANCE_M + depth) / VIEW_DISTANCE_M
      positions[i * 3] = seeds[i * 3]! * ctx.windowWidthM * magnification * 1.6
      positions[i * 3 + 1] = seeds[i * 3 + 1]! * ctx.windowHeightM * magnification * 1.6
      positions[i * 3 + 2] = -depth
    }

    geometry.attributes['position']!.needsUpdate = true
    geometry.computeBoundingSphere()
  }

  return { points, place }
}
