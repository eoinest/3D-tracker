import {
  AmbientLight,
  BoxGeometry,
  DirectionalLight,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PointLight,
  SphereGeometry,
  TorusKnotGeometry,
} from 'three'

import { createRoom } from './room'
import { disposeObject, mulberry32, paletteColor } from './shared'
import type { SceneContext, SceneDefinition, SceneInstance } from './types'

/**
 * The reference demo: a lit room that sits entirely behind the glass, with
 * objects scattered through its depth. Objects at several distances are the
 * point — parallax is a *relative* cue, so a scene with everything at one depth
 * reads as a flat picture that wobbles.
 */
export const portalRoomScene: SceneDefinition = {
  id: 'portal-room',
  name: 'Portal Room',
  description: 'A box behind the glass. Lean around to see into its corners.',
  badge: 'Start here',
  kind: 'world',
  create: createPortalRoom,
}

interface Floater {
  object: Object3D
  /** Depth as a fraction of room depth, so the layout follows the room. */
  depth: number
  ux: number
  uy: number
  baseY: number
  /** Diameter as a fraction of window height, times the unit-scale correction. */
  scale: number
  spin: number
  bob: number
  phase: number
}

function createPortalRoom(ctx: SceneContext): SceneInstance {
  const root = new Group()
  root.name = 'portal-room'

  const room = createRoom()
  room.layout(ctx)
  root.add(room.group)

  root.add(new AmbientLight(0xffffff, 0.35))

  const key = new DirectionalLight(0xffffff, 1.4)
  key.castShadow = true
  key.shadow.mapSize.set(1024, 1024)
  key.shadow.bias = -0.0009
  root.add(key)

  const fillA = new PointLight(0x4cc9f0, 0.12, 1.6, 2)
  const fillB = new PointLight(0xf72585, 0.1, 1.6, 2)
  root.add(fillA, fillB)

  const rand = mulberry32(0x5eed)
  const geometries = [
    new IcosahedronGeometry(1, 0),
    new BoxGeometry(1.4, 1.4, 1.4),
    new SphereGeometry(1, 32, 16),
    new TorusKnotGeometry(0.8, 0.26, 128, 24),
  ]
  // A torus knot's bounding sphere is nearly three times a unit sphere's, so
  // scale by measured extent rather than by the geometry's nominal radius —
  // otherwise the knots come out big enough to punch through the walls.
  const unitScale = geometries.map((geometry) => {
    geometry.computeBoundingSphere()
    return 1 / (2 * (geometry.boundingSphere?.radius ?? 1))
  })

  const floaters: Floater[] = []
  for (let i = 0; i < 14; i++) {
    const slot = i % geometries.length
    const geometry = geometries[slot]!
    const material = new MeshStandardMaterial({
      color: paletteColor(i),
      roughness: 0.25 + rand() * 0.5,
      metalness: rand() > 0.55 ? 0.85 : 0.1,
    })
    const mesh = new Mesh(geometry, material)
    mesh.castShadow = true
    mesh.receiveShadow = true

    // Bias sizes with depth so distant objects stay legible.
    const depth = 0.12 + (i / 14) * 0.82 + rand() * 0.06
    const diameter = (0.07 + rand() * 0.09) * (1 + depth)

    const floater: Floater = {
      object: mesh,
      depth,
      ux: (rand() - 0.5) * 1.55,
      uy: (rand() - 0.5) * 1.5,
      baseY: 0,
      scale: diameter * unitScale[slot]!,
      spin: (rand() - 0.5) * 1.2,
      bob: 0.004 + rand() * 0.01,
      phase: rand() * Math.PI * 2,
    }
    floaters.push(floater)
    root.add(mesh)
  }

  const place = (c: SceneContext): void => {
    const halfW = c.windowWidthM / 2
    const halfH = c.windowHeightM / 2
    for (const f of floaters) {
      // Keep floaters inside the box with a margin that grows with depth, so
      // nothing intersects a wall when you lean.
      f.object.scale.setScalar(f.scale * c.windowHeightM)
      // Pull positions in by the object's own radius so nothing intersects a
      // wall — the moment one does, the box stops reading as a solid room.
      const radius = (f.scale * c.windowHeightM) / 2
      f.baseY = clampAbs(f.uy * halfH, halfH - radius - 0.004)
      f.object.position.set(
        clampAbs(f.ux * halfW, halfW - radius - 0.004),
        f.baseY,
        -f.depth * c.roomDepthM,
      )
    }
    fillA.position.set(-halfW * 0.7, halfH * 0.6, -c.roomDepthM * 0.25)
    fillB.position.set(halfW * 0.7, -halfH * 0.4, -c.roomDepthM * 0.75)

    // Fit the shadow frustum to the actual room. A fixed-size frustum either
    // wastes the whole shadow map on empty space around a 30cm box, or clips
    // the far corners on a large display — the room's size is not a constant.
    const diagonal = Math.hypot(c.windowWidthM, c.windowHeightM, c.roomDepthM)
    const span = diagonal * 0.6
    const distance = diagonal * 1.5
    key.position.set(distance * 0.44, distance * 0.69, distance * 0.57)
    key.shadow.camera.near = 0.02
    key.shadow.camera.far = distance + diagonal
    key.shadow.camera.left = -span
    key.shadow.camera.right = span
    key.shadow.camera.top = span
    key.shadow.camera.bottom = -span
    key.shadow.camera.updateProjectionMatrix()
  }
  place(ctx)

  return {
    root,
    resize(c) {
      room.layout(c)
      place(c)
    },
    update(_dt, elapsed, c) {
      room.setVisible(c.settings.showRoom)
      for (const f of floaters) {
        f.object.rotation.y = elapsed * f.spin
        f.object.rotation.x = elapsed * f.spin * 0.6
        f.object.position.y = f.baseY + Math.sin(elapsed * 0.9 + f.phase) * f.bob
      }
    },
    dispose() {
      disposeObject(root)
      for (const g of geometries) g.dispose()
    },
  }
}

function clampAbs(value: number, limit: number): number {
  const bound = Math.max(0, limit)
  return value < -bound ? -bound : value > bound ? bound : value
}
