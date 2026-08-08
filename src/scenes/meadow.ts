import {
  Color,
  ConeGeometry,
  DirectionalLight,
  FogExp2,
  Group,
  HemisphereLight,
  MeshStandardMaterial,
  SphereGeometry,
} from 'three'

import { fbm2D } from './noise'
import {
  createGrassField,
  createGround,
  createSkyDome,
  rollingHeightField,
  scatter,
  type GrassField,
  type Ground,
} from './outdoorKit'
import { createWindowReveal } from './reveal'
import { disposeObject } from './shared'
import type { SceneContext, SceneDefinition, SceneInstance } from './types'

/**
 * A grass meadow under an open sky, seen through a hole in a wall.
 *
 * Everything here is at true scale. That is what separates "a window onto
 * somewhere" from "a small model of somewhere": grass is centimetres, the
 * treeline is a hundred metres out, and the aperture is 30cm of hole half a
 * metre from your eye. Because of that scale, almost all of the parallax comes
 * from the reveal and the nearest few metres of grass — the hills barely shift
 * at all, exactly as they don't when you lean at a real window.
 */
export const meadowScene: SceneDefinition = {
  id: 'meadow',
  name: 'Meadow',
  description: 'A grass field under an open sky. Lean, and the sill slides across it.',
  badge: 'Window',
  kind: 'world',
  // The treeline sits ~250m out and the sky dome further still.
  minFarM: 700,
  create: createMeadow,
}

/** Eye height above the field, in metres, at the default Depth setting. */
const BASE_EYE_HEIGHT_M = 0.3
const EYE_HEIGHT_PER_DEPTH = 0.42

const SUN = { elevationDeg: 27, azimuthDeg: 34 }
const FOG_COLOR = 0xbdd0e0

function createMeadow(ctx: SceneContext): SceneInstance {
  const root = new Group()
  root.name = 'meadow'

  const sky = createSkyDome({
    ...SUN,
    turbidity: 3.4,
    rayleigh: 1.9,
    cloudCoverage: 0.46,
    cloudDensity: 0.42,
    cloudSpeed: 0.00005,
  })
  root.add(sky.object)

  // A hemisphere light is a much better fit than an IBL here: it costs nothing
  // and gives exactly the sky-above / bounce-below gradient an open field has.
  const ambient = new HemisphereLight(0xa9c8e8, 0x4a5a2c, 1.35)
  root.add(ambient)

  const sun = new DirectionalLight(0xfff0d6, 2.6)
  sun.position.copy(sky.sunDirection).multiplyScalar(40)
  root.add(sun, sun.target)

  // ── Terrain ───────────────────────────────────────────────────────────────
  const heightAt = rollingHeightField(0x4d3a, { amplitudeM: 7.5, scaleM: 210 })
  const patchNoise = fbm2D(0x91b3, { octaves: 3, frequency: 1 / 14 })

  const grassDark = new Color(0x39561f)
  const grassLight = new Color(0x7d9a49)
  const dirt = new Color(0x6d5c3c)

  const ground: Ground = createGround({
    heightAt,
    outerRadiusM: 340,
    colorAt(x, z, _height, slope, target) {
      // Mottle the field so the ground under and beyond the grass instances
      // doesn't read as one flat sheet of green.
      const patch = (patchNoise(x, z) + 1) / 2
      target.copy(grassDark).lerp(grassLight, patch * 0.85 + 0.1)
      if (slope > 0.35) target.lerp(dirt, Math.min(1, (slope - 0.35) * 2.2))
    },
  })
  root.add(ground.mesh)

  // ── Grass ─────────────────────────────────────────────────────────────────
  const grass: GrassField = createGrassField({
    heightAt,
    count: 54000,
    // Nothing closer than ~4m is above the window's bottom edge, so blades
    // inside that are pure cost. Starting at 2m leaves headroom for leaning.
    minRadiusM: 2,
    maxRadiusM: 48,
    bladeHeightM: [0.26, 0.7],
    bladeWidthM: 0.026,
    windStrength: 0.15,
    windSpeed: 0.9,
  })
  root.add(grass.mesh)

  // ── Wildflowers ───────────────────────────────────────────────────────────
  // Small and round. Faceted icosahedra at bloom scale read as pebbles
  // scattered through the field rather than as flowers.
  const flowerGeometry = new SphereGeometry(1, 7, 5)
  const flowerMaterial = new MeshStandardMaterial({ roughness: 0.65, metalness: 0 })
  const petals = [
    new Color(0xffe14a),
    new Color(0xf05fa0),
    new Color(0x9a7ce8),
    new Color(0xff8f3a),
    new Color(0xf5f0e0),
  ]
  const flowers = scatter(flowerGeometry, flowerMaterial, {
    count: 2600,
    seed: 0x2f10,
    minRadiusM: 2,
    maxRadiusM: 32,
    distribution: 'log',
    heightAt,
    place(dummy, _x, y, _z, random) {
      // Sit the head near grass-tip height so blooms peek out of the field.
      dummy.position.y = y + 0.2 + random() * 0.32
      // Flatten into a disc: a sphere at bloom scale reads as a bead, while a
      // squashed one reads as a flower head seen edge-on.
      const size = 0.009 + random() * 0.008
      dummy.scale.set(size, size * 0.4, size)
      dummy.rotation.set((random() - 0.5) * 0.9, random() * Math.PI, (random() - 0.5) * 0.9)
    },
    colorAt(_x, _z, random, target) {
      target.copy(petals[Math.floor(random() * petals.length)] ?? petals[0]!)
    },
  })
  flowers.name = 'wildflowers'
  root.add(flowers)

  // ── Distant treeline ──────────────────────────────────────────────────────
  const canopyGeometry = new ConeGeometry(1, 1, 7)
  // Cone geometry is centred on its own origin; shift it so instance scaling
  // grows the tree upward from the ground rather than through it.
  canopyGeometry.translate(0, 0.5, 0)
  const canopyMaterial = new MeshStandardMaterial({
    roughness: 1,
    metalness: 0,
    flatShading: true,
  })
  const canopy = new Color()
  const trees = scatter(canopyGeometry, canopyMaterial, {
    count: 900,
    seed: 0x77aa,
    minRadiusM: 135,
    maxRadiusM: 340,
    areaBias: 1,
    heightAt,
    place(dummy, _x, _y, _z, random) {
      const height = 5 + random() * 7
      dummy.scale.set(height * (0.3 + random() * 0.16), height, height * (0.3 + random() * 0.16))
      dummy.rotation.y = random() * Math.PI
    },
    colorAt(_x, _z, random, target) {
      const t = random()
      target.copy(canopy.setRGB(0.17 + t * 0.1, 0.3 + t * 0.16, 0.13 + t * 0.08))
    },
  })
  trees.name = 'treeline'
  root.add(trees)

  // ── Window ────────────────────────────────────────────────────────────────
  const reveal = createWindowReveal({ depthM: 0.085, color: 0xe4ded1, sillColor: 0xbdb2a0 })
  reveal.layout(ctx)
  root.add(reveal.group)

  const world = new Group()
  world.name = 'meadow-world'
  // Re-parent everything except the reveal, so the whole landscape can be
  // dropped to put the horizon at eye level.
  world.add(ground.mesh, grass.mesh, flowers, trees)
  root.add(world)

  const layout = (c: SceneContext): void => {
    reveal.layout(c)
    const eyeHeight = BASE_EYE_HEIGHT_M + c.roomDepthM * EYE_HEIGHT_PER_DEPTH
    world.position.y = -eyeHeight
    // Keep the sun's shadow target near the visible ground rather than at the
    // origin, which is under the floor.
    sun.target.position.set(0, -eyeHeight, -12)
    sun.target.updateMatrixWorld()
  }
  layout(ctx)

  return {
    root,
    // Exponential fog gives aerial perspective — the treeline dissolves into
    // the horizon haze instead of ending at a hard edge where the mesh stops.
    fog: new FogExp2(FOG_COLOR, 0.0062),
    // The Preetham sky is a physical radiance model; at interior exposure it
    // clips to white across the top half of the frame.
    exposure: 0.42,
    environmentIntensity: 0.12,
    resize: layout,
    update(_dt, elapsed, c) {
      sky.update(elapsed)
      grass.update(elapsed)
      reveal.setVisible(c.settings.showRoom)
    },
    dispose() {
      sky.dispose()
      grass.dispose()
      disposeObject(root)
    },
  }
}
