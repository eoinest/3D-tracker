import {
  Color,
  ExtrudeGeometry,
  Group,
  InstancedMesh,
  MeshBasicMaterial,
  Object3D,
  Path,
  Shape,
} from 'three'

import { disposeObject } from './shared'
import type { SceneContext, SceneDefinition, SceneInstance } from './types'

/**
 * A corridor of glowing rectangular frames flying toward you.
 *
 * This doubles as the calibration target: the frames are concentric with the
 * window and exactly its size, so a correctly calibrated setup keeps them
 * nested and square no matter where your head is. If the screen dimensions or
 * camera offset are wrong, the corridor visibly shears and swims as you move.
 */
export const tunnelScene: SceneDefinition = {
  id: 'tunnel',
  name: 'Infinite Tunnel',
  description: 'Concentric frames rushing past. The quickest way to check calibration.',
  badge: 'Calibrate',
  kind: 'world',
  create: createTunnel,
}

const FRAME_COUNT = 44
/** Metres between frames — also the wrap distance. */
const SPACING = 0.26
const THICKNESS_RATIO = 0.016
const SPEED = 1.5
/** Frames fully fade in by this slot, hiding the wrap at the glass. */
const NEAR_FADE = 3.5
/** Depth (in slots) at which brightness has halved. */
const FALLOFF = 11

const NEAR_COLOR = new Color('#4cc9f0')
const FAR_COLOR = new Color('#f72585')

function createTunnel(ctx: SceneContext): SceneInstance {
  const root = new Group()
  root.name = 'tunnel'

  // Unit frame: a 1×1 square with a square hole, extruded a hair so it catches
  // an edge when you look at it from an angle.
  const shape = new Shape()
  shape.moveTo(-0.5, -0.5)
  shape.lineTo(0.5, -0.5)
  shape.lineTo(0.5, 0.5)
  shape.lineTo(-0.5, 0.5)
  shape.closePath()

  const inner = 0.5 - THICKNESS_RATIO
  const hole = new Path()
  hole.moveTo(-inner, -inner)
  hole.lineTo(-inner, inner)
  hole.lineTo(inner, inner)
  hole.lineTo(inner, -inner)
  hole.closePath()
  shape.holes.push(hole)

  const geometry = new ExtrudeGeometry(shape, { depth: 0.006, bevelEnabled: false })

  // Unlit, so per-instance colour reads as neon without any lighting setup.
  const material = new MeshBasicMaterial({ toneMapped: false })
  const frames = new InstancedMesh(geometry, material, FRAME_COUNT)
  frames.frustumCulled = false
  root.add(frames)

  const dummy = new Object3D()
  const color = new Color()

  let width = ctx.windowWidthM
  let height = ctx.windowHeightM
  let scroll = 0

  const writeFrames = (): void => {
    for (let i = 0; i < FRAME_COUNT; i++) {
      // Wrap into [0, FRAME_COUNT) so frames recycle to the far end as they
      // pass through the glass.
      const slot = (((i - scroll) % FRAME_COUNT) + FRAME_COUNT) % FRAME_COUNT

      dummy.position.set(0, 0, -slot * SPACING)
      dummy.scale.set(width, height, 1)
      dummy.updateMatrix()
      frames.setMatrixAt(i, dummy.matrix)

      // Fade in from the glass and out into the distance. Without the near
      // fade, a frame would blink out at full brightness the instant it wraps.
      const nearFade = Math.min(1, slot / NEAR_FADE)
      const farFade = 1 / (1 + (slot / FALLOFF) ** 2)
      color
        .copy(NEAR_COLOR)
        .lerp(FAR_COLOR, (Math.sin(i * 0.55) + 1) / 2)
        .multiplyScalar(nearFade * farFade)
      frames.setColorAt(i, color)
    }
    frames.instanceMatrix.needsUpdate = true
    if (frames.instanceColor) frames.instanceColor.needsUpdate = true
  }

  writeFrames()

  return {
    root,
    resize(c) {
      width = c.windowWidthM
      height = c.windowHeightM
      writeFrames()
    },
    update(dt) {
      scroll = (scroll + dt * SPEED) % FRAME_COUNT
      writeFrames()
    },
    dispose() {
      disposeObject(root)
      geometry.dispose()
    },
  }
}
