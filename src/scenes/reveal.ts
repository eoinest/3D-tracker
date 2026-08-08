import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
} from 'three'

import type { SceneContext } from './types'

/**
 * The reveal: the thickness of the wall the window is cut through.
 *
 * This is the single highest-value object in any outdoor scene, and it is four
 * quads. A bare aperture reads as a screen showing a landscape; give the
 * opening 12cm of wall and lean sideways, and the near jamb slides across the
 * far one exactly as a real window does. Almost all of the near-field parallax
 * in a real window view comes from the frame, because everything outside is
 * metres away and barely shifts at all.
 *
 * Geometry-wise it is a rectangular tube from z = 0 back to z = −depth, sized
 * exactly to the aperture. It is always inside the frustum, because the frustum
 * cross-section grows with distance while the tube does not.
 */
export interface WindowReveal {
  group: Group
  layout(ctx: SceneContext): void
  setVisible(visible: boolean): void
}

export interface RevealOptions {
  /** Wall thickness in metres. */
  depthM?: number
  /** Jamb colour. */
  color?: number
  /** Sill colour; the bottom jamb is treated as a windowsill. */
  sillColor?: number
  /** How dark the interior lip gets, 0–1. */
  contactShade?: number
}

export function createWindowReveal(options: RevealOptions = {}): WindowReveal {
  const { depthM = 0.12, color = 0xd9d3c8, sillColor = 0xb9b0a1, contactShade = 0.42 } = options

  const group = new Group()
  group.name = 'window-reveal'

  // DoubleSide costs nothing across eight triangles and removes a whole class
  // of winding-order mistakes in hand-built geometry.
  const jambMaterial = new MeshStandardMaterial({
    color,
    roughness: 0.95,
    metalness: 0,
    vertexColors: true,
    side: DoubleSide,
  })
  const sillMaterial = new MeshStandardMaterial({
    color: sillColor,
    roughness: 0.8,
    metalness: 0.02,
    vertexColors: true,
    side: DoubleSide,
  })

  const jambs = new Mesh(new BufferGeometry(), jambMaterial)
  const sill = new Mesh(new BufferGeometry(), sillMaterial)
  jambs.receiveShadow = true
  sill.receiveShadow = true
  group.add(jambs, sill)

  const build = (quads: number[][][]): BufferGeometry => {
    const positions: number[] = []
    const normals: number[] = []
    const colors: number[] = []
    const indices: number[] = []

    quads.forEach((quad, q) => {
      const normal = quad[4]!
      for (let i = 0; i < 4; i++) {
        const v = quad[i]!
        positions.push(v[0]!, v[1]!, v[2]!)
        normals.push(normal[0]!, normal[1]!, normal[2]!)
        // Shade by depth into the wall: the lip at z = 0 sits in the interior's
        // shadow, the far edge catches the sky. Cheap, and it is what makes the
        // opening read as thick rather than as a printed border.
        const t = Math.min(1, Math.abs(v[2]!) / depthM)
        const shade = contactShade + (1 - contactShade) * t
        colors.push(shade, shade, shade)
      }
      const base = q * 4
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
    })

    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3))
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3))
    geometry.setIndex(indices)
    return geometry
  }

  return {
    group,
    layout(ctx) {
      const hw = ctx.windowWidthM / 2
      const hh = ctx.windowHeightM / 2
      const d = -depthM

      jambs.geometry.dispose()
      jambs.geometry = build([
        // top
        [[-hw, hh, 0], [hw, hh, 0], [hw, hh, d], [-hw, hh, d], [0, -1, 0]],
        // left
        [[-hw, -hh, 0], [-hw, hh, 0], [-hw, hh, d], [-hw, -hh, d], [1, 0, 0]],
        // right
        [[hw, -hh, 0], [hw, hh, 0], [hw, hh, d], [hw, -hh, d], [-1, 0, 0]],
      ])

      sill.geometry.dispose()
      sill.geometry = build([
        [[-hw, -hh, 0], [hw, -hh, 0], [hw, -hh, d], [-hw, -hh, d], [0, 1, 0]],
      ])
    },
    setVisible(visible) {
      group.visible = visible
    },
  }
}
