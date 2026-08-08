import {
  AmbientLight,
  Box3,
  CylinderGeometry,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SpotLight,
  Vector3,
} from 'three'

import { createRoom } from './room'
import { disposeObject } from './shared'
import type { SceneContext, SceneInstance } from './types'

/**
 * A single object on a pedestal inside the portal room — the mode used for
 * every uploaded model.
 *
 * The object is normalised into the room rather than shown at its authored
 * scale: a 40-metre CAD assembly and a 2-centimetre trinket both need to end
 * up a few centimetres tall to sit inside a window the size of a laptop screen.
 */

export interface ShowcaseOptions {
  /** Fraction of window height the object should occupy. */
  fit?: number
  /** Depth into the room, as a fraction of room depth. */
  depth?: number
  pedestal?: boolean
  /** Extra spin applied on top of the autoRotate setting, in rad/s. */
  idleSpin?: number
  /**
   * Leave `content` alone when the scene is torn down. Set for user uploads,
   * which outlive any single scene and would otherwise be freed on the first
   * switch away from them.
   */
  keepContent?: boolean
}

export function createShowcase(
  content: Object3D,
  ctx: SceneContext,
  options: ShowcaseOptions = {},
): SceneInstance {
  const { fit = 0.62, depth = 0.45, pedestal = true, idleSpin = 0, keepContent = false } = options

  const root = new Group()
  root.name = 'showcase'

  const room = createRoom({ tint: 0x6d7f99 })
  room.layout(ctx)
  root.add(room.group)

  root.add(new AmbientLight(0xffffff, 0.45))

  const key = new DirectionalLight(0xffffff, 1.5)
  key.castShadow = true
  key.shadow.mapSize.set(1024, 1024)
  key.shadow.bias = -0.0008
  root.add(key, key.target)

  const spot = new SpotLight(0xcfe4ff, 1.4, 2.5, Math.PI / 5, 0.55, 1.6)
  spot.castShadow = false
  root.add(spot, spot.target)

  // Pivot carries the auto-rotation; the model hangs off it already centred and
  // scaled, so spinning never drifts it off the pedestal.
  const pivot = new Group()
  pivot.name = 'showcase-pivot'
  root.add(pivot)

  const holder = new Group()
  holder.name = 'showcase-content'
  pivot.add(holder)

  // The centring offset lives on this wrapper, never on `content` itself —
  // uploads get shown again after a scene switch, and baking the offset into
  // the model would shift it a little further every time.
  const frame = new Group()
  frame.name = 'showcase-frame'
  frame.add(content)
  holder.add(frame)

  content.traverse((obj) => {
    const mesh = obj as Mesh
    if (mesh.isMesh) {
      mesh.castShadow = true
      mesh.receiveShadow = true
    }
  })

  const plinth = new Mesh(
    new CylinderGeometry(1, 1.06, 1, 48),
    new MeshStandardMaterial({ color: 0x1b2433, roughness: 0.55, metalness: 0.35 }),
  )
  plinth.receiveShadow = true
  plinth.castShadow = true
  plinth.visible = pedestal
  root.add(plinth)

  // Measure once, in the model's own space, then drive everything from it.
  const bounds = new Box3().setFromObject(content)
  const size = bounds.getSize(new Vector3())
  const center = bounds.getCenter(new Vector3())
  const maxDim = Math.max(size.x, size.y, size.z) || 1
  // Centre horizontally, and re-seat vertically so the base sits at y = 0.
  frame.position.set(-center.x, -center.y + size.y / 2, -center.z)

  let currentScale = 1

  const layout = (c: SceneContext): void => {
    room.layout(c)

    const target = c.windowHeightM * fit
    currentScale = (target / maxDim) * Math.max(0.01, c.settings.modelScale)
    holder.scale.setScalar(currentScale)

    const plinthTopY = -c.windowHeightM / 2 + 0.012
    const z = -c.roomDepthM * depth

    plinth.scale.set(
      Math.max(0.02, (size.x * currentScale) / 2 + 0.02),
      0.024,
      Math.max(0.02, (size.z * currentScale) / 2 + 0.02),
    )
    plinth.position.set(0, plinthTopY - 0.012, z)

    pivot.position.set(0, plinthTopY, z)

    const focusY = plinthTopY + size.y * currentScale * 0.4
    const diagonal = Math.hypot(c.windowWidthM, c.windowHeightM, c.roomDepthM)
    const span = diagonal * 0.55
    const distance = diagonal * 1.4
    key.position.set(distance * 0.4, focusY + distance * 0.6, z + distance * 0.55)
    key.target.position.set(0, focusY, z)
    key.target.updateMatrixWorld()
    key.shadow.camera.near = 0.02
    key.shadow.camera.far = distance + diagonal
    key.shadow.camera.left = -span
    key.shadow.camera.right = span
    key.shadow.camera.top = span
    key.shadow.camera.bottom = -span
    key.shadow.camera.updateProjectionMatrix()

    spot.position.set(0, c.windowHeightM * 0.48, z + 0.02)
    spot.target.position.set(0, plinthTopY, z)
    spot.target.updateMatrixWorld()
    spot.distance = diagonal * 3
  }
  layout(ctx)

  return {
    root,
    resize: layout,
    update(dt, elapsed, c) {
      room.setVisible(c.settings.showRoom)
      plinth.visible = pedestal && c.settings.showRoom
      if (c.settings.autoRotate) pivot.rotation.y += dt * 0.5
      else if (idleSpin) pivot.rotation.y = elapsed * idleSpin

      const wanted = (c.windowHeightM * fit) / maxDim * Math.max(0.01, c.settings.modelScale)
      if (Math.abs(wanted - currentScale) > 1e-6) layout(c)
    },
    dispose() {
      if (keepContent) frame.remove(content)
      disposeObject(root)
    },
  }
}
