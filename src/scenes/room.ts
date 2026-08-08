import {
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  type Texture,
} from 'three'

import { makeGridTexture } from './shared'
import type { SceneContext } from './types'

/**
 * The five inner faces of a box whose open front face is exactly the screen.
 *
 * Aligning the box opening with the physical window is what makes the edges of
 * the display read as the edges of a real aperture: the walls converge into the
 * screen and the bezel becomes the window frame.
 */
export interface Room {
  group: Group
  layout(ctx: SceneContext): void
  setVisible(visible: boolean): void
}

/** Metres of wall covered by one texture tile. */
const TILE_M = 0.22

export function createRoom(options: { color?: number; tint?: number } = {}): Room {
  const { color = 0xffffff, tint = 0x8fa6c4 } = options

  const group = new Group()
  group.name = 'room'

  const geometry = new PlaneGeometry(1, 1)
  const baseTexture = makeGridTexture()

  const faces: { mesh: Mesh; texture: Texture }[] = []

  const makeFace = (name: string, emissiveIntensity: number): Mesh => {
    const texture = baseTexture.clone()
    texture.needsUpdate = true
    const material = new MeshStandardMaterial({
      map: texture,
      color,
      roughness: 0.85,
      metalness: 0.05,
      emissive: tint,
      emissiveIntensity,
    })
    const mesh = new Mesh(geometry, material)
    mesh.name = name
    mesh.receiveShadow = true
    group.add(mesh)
    faces.push({ mesh, texture })
    return mesh
  }

  const back = makeFace('wall-back', 0.05)
  const floor = makeFace('wall-floor', 0.02)
  const ceiling = makeFace('wall-ceiling', 0.02)
  const left = makeFace('wall-left', 0.03)
  const right = makeFace('wall-right', 0.03)

  floor.rotation.x = -Math.PI / 2
  ceiling.rotation.x = Math.PI / 2
  left.rotation.y = Math.PI / 2
  right.rotation.y = -Math.PI / 2

  const tile = (index: number, u: number, v: number): void => {
    const texture = faces[index]!.texture
    texture.repeat.set(Math.max(1, u / TILE_M), Math.max(1, v / TILE_M))
  }

  return {
    group,
    layout(ctx) {
      const w = ctx.windowWidthM
      const h = ctx.windowHeightM
      const d = ctx.roomDepthM

      back.position.set(0, 0, -d)
      back.scale.set(w, h, 1)
      tile(0, w, h)

      floor.position.set(0, -h / 2, -d / 2)
      floor.scale.set(w, d, 1)
      tile(1, w, d)

      ceiling.position.set(0, h / 2, -d / 2)
      ceiling.scale.set(w, d, 1)
      tile(2, w, d)

      left.position.set(-w / 2, 0, -d / 2)
      left.scale.set(d, h, 1)
      tile(3, d, h)

      right.position.set(w / 2, 0, -d / 2)
      right.scale.set(d, h, 1)
      tile(4, d, h)
    },
    setVisible(visible) {
      group.visible = visible
    },
  }
}
