import {
  AmbientLight,
  BoxGeometry,
  CapsuleGeometry,
  ConeGeometry,
  DirectionalLight,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  PointLight,
  SphereGeometry,
} from 'three'

import { disposeObject, makeGridTexture, makeSkyTexture, paletteColor } from './shared'
import type { SceneContext, SceneDefinition, SceneInstance } from './types'

/**
 * A top-down game level seen through the window, as a tilted diorama.
 *
 * This is the case head tracking helps most with in an actual game: a fixed
 * top-down camera loses everything behind a wall, and normally you fix that
 * with transparency hacks or a camera the player has to fight. Here you just
 * lean, and the parallax shows you what's behind the wall — the occlusion
 * problem solves itself because the viewer's eye is a real degree of freedom.
 */
export const arenaScene: SceneDefinition = {
  id: 'top-down-arena',
  name: 'Top-Down Arena',
  description: 'A game board behind the glass. WASD to drive; lean to see behind walls.',
  badge: 'Interactive',
  kind: 'world',
  create: createArena,
}

/** Level dimensions in authoring units; the group is uniformly scaled to fit. */
const LEVEL_W = 1.35
const LEVEL_D = 2.3
const WALL_H = 0.11
const PLAYER_R = 0.035
const PLAYER_SPEED = 0.62
/** Board tilt toward the viewer, in radians. Raises the far end into view. */
const TILT = 0.2
/** Assumed viewing distance, matching main.ts's nominal. Only sets framing. */
const VIEW_DISTANCE_M = 0.55
/** How much of the visible width at the board's depth the board should fill. */
const FILL = 0.92

interface Block {
  x: number
  z: number
  w: number
  d: number
  h: number
}

/** Hand-placed cover so there is always something to peek around. */
const BLOCKS: Block[] = [
  { x: -0.34, z: -0.55, w: 0.42, d: 0.09, h: 0.13 },
  { x: 0.36, z: -0.2, w: 0.09, d: 0.5, h: 0.15 },
  { x: -0.1, z: 0.35, w: 0.5, d: 0.09, h: 0.1 },
  { x: 0.12, z: 0.75, w: 0.09, d: 0.42, h: 0.17 },
  { x: -0.45, z: 0.62, w: 0.2, d: 0.2, h: 0.09 },
  { x: 0.45, z: 0.72, w: 0.22, d: 0.1, h: 0.12 },
  { x: -0.05, z: -0.9, w: 0.3, d: 0.1, h: 0.14 },
]

const PATROLS: { from: [number, number]; to: [number, number]; period: number }[] = [
  { from: [-0.5, -0.9], to: [0.5, -0.75], period: 7 },
  { from: [0.5, 0.95], to: [-0.5, 0.5], period: 9 },
  { from: [0.05, -0.35], to: [0.05, 0.9], period: 11 },
]

const PICKUPS: [number, number][] = [
  [-0.5, -0.3],
  [0.5, -0.95],
  [-0.5, 1.0],
  [0.5, 0.35],
  [0, 0.05],
  [-0.15, -1.0],
]

function createArena(ctx: SceneContext): SceneInstance {
  const root = new Group()
  root.name = 'arena'

  const level = new Group()
  level.name = 'level'
  root.add(level)

  root.add(new AmbientLight(0xffffff, 0.45))

  // Lights live outside `level` because `level` is uniformly scaled to the
  // window, and a light's shadow-frustum extents and falloff distance are in
  // world units — parenting them to a scaled group silently shrinks the lit
  // region on large displays.
  const sun = new DirectionalLight(0xfff2e0, 1.7)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.bias = -0.0008
  root.add(sun, sun.target)

  const rim = new PointLight(0x4cc9f0, 0.35, 3, 2)
  root.add(rim)

  // Without something behind it the board floats in flat black, which reads as
  // a rendering glitch rather than as depth.
  const backdrop = new Mesh(
    new PlaneGeometry(1, 1),
    new MeshBasicMaterial({ map: makeSkyTexture(), depthWrite: false, toneMapped: false }),
  )
  backdrop.renderOrder = -1
  root.add(backdrop)

  // ── Floor ─────────────────────────────────────────────────────────────────
  const floorTexture = makeGridTexture({ background: '#101826', line: '#1e2c42', accent: '#2f4f7a' })
  floorTexture.repeat.set(LEVEL_W / 0.15, LEVEL_D / 0.15)
  const floor = new Mesh(
    new PlaneGeometry(LEVEL_W, LEVEL_D),
    new MeshStandardMaterial({ map: floorTexture, roughness: 0.95, metalness: 0 }),
  )
  floor.rotation.x = -Math.PI / 2
  floor.receiveShadow = true
  level.add(floor)

  // ── Static geometry ───────────────────────────────────────────────────────
  const boxGeometry = new BoxGeometry(1, 1, 1)
  const wallMaterial = new MeshStandardMaterial({ color: 0x2b3a55, roughness: 0.8, metalness: 0.1 })

  const colliders: Block[] = []

  const addBlock = (block: Block, material: MeshStandardMaterial): void => {
    const mesh = new Mesh(boxGeometry, material)
    mesh.scale.set(block.w, block.h, block.d)
    mesh.position.set(block.x, block.h / 2, block.z)
    mesh.castShadow = true
    mesh.receiveShadow = true
    level.add(mesh)
    colliders.push(block)
  }

  const border = 0.05
  const perimeter: Block[] = [
    { x: 0, z: -LEVEL_D / 2, w: LEVEL_W, d: border, h: WALL_H },
    { x: 0, z: LEVEL_D / 2, w: LEVEL_W, d: border, h: WALL_H },
    { x: -LEVEL_W / 2, z: 0, w: border, d: LEVEL_D, h: WALL_H },
    { x: LEVEL_W / 2, z: 0, w: border, d: LEVEL_D, h: WALL_H },
  ]
  for (const block of perimeter) addBlock(block, wallMaterial)

  BLOCKS.forEach((block, i) => {
    addBlock(
      block,
      new MeshStandardMaterial({
        color: paletteColor(i + 3).clone().multiplyScalar(0.55),
        roughness: 0.6,
        metalness: 0.2,
      }),
    )
  })

  // ── Player ────────────────────────────────────────────────────────────────
  const player = new Group()
  const body = new Mesh(
    new CapsuleGeometry(PLAYER_R, 0.05, 6, 16),
    new MeshStandardMaterial({ color: 0x4ad66d, roughness: 0.35, metalness: 0.3 }),
  )
  body.position.y = PLAYER_R + 0.025
  body.castShadow = true
  const nose = new Mesh(
    new ConeGeometry(0.02, 0.05, 16),
    new MeshStandardMaterial({ color: 0xffd166, emissive: 0x6b4d00, roughness: 0.4 }),
  )
  nose.rotation.x = -Math.PI / 2
  nose.position.set(0, PLAYER_R + 0.02, -PLAYER_R - 0.02)
  nose.castShadow = true
  player.add(body, nose)
  // Spawn back from the near edge, which the window's bottom rail crops.
  player.position.set(0, 0, 0.55)
  level.add(player)

  const glow = new PointLight(0x4ad66d, 0.55, 0.7, 2)
  glow.position.y = 0.08
  player.add(glow)

  // ── Enemies ───────────────────────────────────────────────────────────────
  const enemyGeometry = new SphereGeometry(0.035, 24, 16)
  const enemies = PATROLS.map((_, i) => {
    const mesh = new Mesh(
      enemyGeometry,
      new MeshStandardMaterial({
        color: 0xf72585,
        emissive: 0x4a0021,
        roughness: 0.3,
        metalness: 0.4,
      }),
    )
    mesh.castShadow = true
    mesh.position.y = 0.035
    mesh.name = `enemy-${i}`
    level.add(mesh)
    return mesh
  })

  // ── Pickups ───────────────────────────────────────────────────────────────
  const pickupGeometry = new OctahedronGeometry(0.022, 0)
  const pickupMaterial = new MeshStandardMaterial({
    color: 0xffd166,
    emissive: 0x8a6a00,
    roughness: 0.2,
    metalness: 0.6,
  })
  const pickups = PICKUPS.map(([x, z]) => {
    const mesh = new Mesh(pickupGeometry, pickupMaterial)
    mesh.position.set(x, 0.055, z)
    mesh.castShadow = true
    level.add(mesh)
    return { mesh, respawnAt: 0 }
  })

  // ── Input ─────────────────────────────────────────────────────────────────
  const held = new Set<string>()
  const AXIS_KEYS = new Set([
    'KeyW',
    'KeyA',
    'KeyS',
    'KeyD',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
  ])

  const layout = (c: SceneContext): void => {
    // Scale to the frustum, not to the window. The window is a keyhole: at the
    // board's depth the visible area is much wider than the glass, and sizing
    // the board off the glass alone leaves you nose-to-nose with one crate.
    //
    // Fit the board's *near* edge, which is the widest-looking part of it. The
    // scale appears on both sides of that constraint (moving the near edge
    // changes how wide the frustum is there), so solve for it:
    //
    //   LEVEL_W·s = FILL · windowW · (V − centerZ − (LEVEL_D/2)·s) / V
    const centerZ = -c.roomDepthM * 0.95
    const fillWidth = FILL * c.windowWidthM
    const scale =
      (fillWidth * (VIEW_DISTANCE_M - centerZ)) /
      (LEVEL_W * VIEW_DISTANCE_M + (fillWidth * LEVEL_D) / 2)

    level.scale.setScalar(scale)
    level.rotation.x = TILT
    level.position.set(0, -c.windowHeightM * 0.5, centerZ)

    const diagonal = Math.hypot(LEVEL_W, LEVEL_D) * scale
    const span = diagonal * 0.6
    const distance = diagonal * 1.3
    sun.position.set(
      distance * 0.3,
      level.position.y + distance * 0.85,
      level.position.z + distance * 0.45,
    )
    sun.target.position.copy(level.position)
    sun.target.updateMatrixWorld()
    sun.shadow.camera.near = 0.05
    sun.shadow.camera.far = distance + diagonal
    sun.shadow.camera.left = -span
    sun.shadow.camera.right = span
    sun.shadow.camera.top = span
    sun.shadow.camera.bottom = -span
    sun.shadow.camera.updateProjectionMatrix()

    rim.position.set(-c.windowWidthM * 1.2, level.position.y + diagonal * 0.3, -c.roomDepthM * 0.2)
    rim.distance = diagonal * 1.6

    // Park the backdrop just past the far wall and size it to overfill the
    // frustum there, so it never shows an edge however far you lean.
    const backdropZ = centerZ - LEVEL_D * scale
    const magnification = (VIEW_DISTANCE_M - backdropZ) / VIEW_DISTANCE_M
    backdrop.position.set(0, level.position.y * 0.4, backdropZ)
    backdrop.scale.set(c.windowWidthM * magnification * 2.4, c.windowHeightM * magnification * 2.4, 1)
  }
  layout(ctx)

  return {
    root,
    resize: layout,
    onKey(event, down) {
      if (!AXIS_KEYS.has(event.code)) return false
      if (down) held.add(event.code)
      else held.delete(event.code)
      return true
    },
    update(dt, elapsed) {
      // Movement is in level-local space, so the tilt never fights the controls.
      let mx = 0
      let mz = 0
      if (held.has('KeyA') || held.has('ArrowLeft')) mx -= 1
      if (held.has('KeyD') || held.has('ArrowRight')) mx += 1
      if (held.has('KeyW') || held.has('ArrowUp')) mz -= 1
      if (held.has('KeyS') || held.has('ArrowDown')) mz += 1

      if (mx || mz) {
        const len = Math.hypot(mx, mz)
        const step = (PLAYER_SPEED * dt) / len
        player.position.x += mx * step
        player.position.z += mz * step
        player.rotation.y = Math.atan2(mx, mz) + Math.PI
      }

      resolveCollisions(player.position, PLAYER_R, colliders)
      const limitX = LEVEL_W / 2 - border - PLAYER_R
      const limitZ = LEVEL_D / 2 - border - PLAYER_R
      player.position.x = clamp(player.position.x, -limitX, limitX)
      player.position.z = clamp(player.position.z, -limitZ, limitZ)

      PATROLS.forEach((patrol, i) => {
        const mesh = enemies[i]
        if (!mesh) return
        const t = (Math.sin((elapsed / patrol.period) * Math.PI * 2) + 1) / 2
        mesh.position.x = patrol.from[0] + (patrol.to[0] - patrol.from[0]) * t
        mesh.position.z = patrol.from[1] + (patrol.to[1] - patrol.from[1]) * t
        mesh.position.y = 0.035 + Math.abs(Math.sin(elapsed * 3 + i)) * 0.02
      })

      for (const pickup of pickups) {
        if (!pickup.mesh.visible) {
          if (elapsed >= pickup.respawnAt) pickup.mesh.visible = true
          continue
        }
        pickup.mesh.rotation.y = elapsed * 2
        pickup.mesh.position.y = 0.055 + Math.sin(elapsed * 3 + pickup.mesh.position.x * 10) * 0.008
        const dx = pickup.mesh.position.x - player.position.x
        const dz = pickup.mesh.position.z - player.position.z
        if (Math.hypot(dx, dz) < PLAYER_R + 0.03) {
          pickup.mesh.visible = false
          pickup.respawnAt = elapsed + 6
        }
      }
    },
    dispose() {
      held.clear()
      disposeObject(root)
      boxGeometry.dispose()
      enemyGeometry.dispose()
      pickupGeometry.dispose()
    },
  }
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

/** Circle-vs-AABB push-out, resolved along the shallowest axis. */
function resolveCollisions(
  position: { x: number; z: number },
  radius: number,
  blocks: readonly Block[],
): void {
  for (const block of blocks) {
    const halfW = block.w / 2 + radius
    const halfD = block.d / 2 + radius
    const dx = position.x - block.x
    const dz = position.z - block.z
    if (Math.abs(dx) >= halfW || Math.abs(dz) >= halfD) continue

    const overlapX = halfW - Math.abs(dx)
    const overlapZ = halfD - Math.abs(dz)
    if (overlapX < overlapZ) {
      position.x += dx >= 0 ? overlapX : -overlapX
    } else {
      position.z += dz >= 0 ? overlapZ : -overlapZ
    }
  }
}
