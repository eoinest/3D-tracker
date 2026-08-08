import {
  type BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  FogExp2,
  Group,
  HemisphereLight,
  InstancedMesh,
  MeshStandardMaterial,
  Object3D,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

import { fbm2D, rng, type Noise2D } from './noise'
import {
  createGrassField,
  createGround,
  createSkyDome,
  rollingHeightField,
  type GrassField,
} from './outdoorKit'
import { createWindowReveal } from './reveal'
import { disposeObject } from './shared'
import type { SceneContext, SceneDefinition, SceneInstance } from './types'

/**
 * A conifer forest in low morning mist.
 *
 * Where the meadow leans on near geometry for its parallax, this one leans on
 * *occlusion*: hundreds of trunks spread from fifteen metres out to a hundred.
 * Shifting your head slides the near trunks across the far ones, and because
 * each is a hard-edged silhouette against fog, the depth ordering is
 * unmistakable. The mist does double duty — aerial perspective, and hiding the
 * point where the trees stop.
 */
export const pineRidgeScene: SceneDefinition = {
  id: 'pine-ridge',
  name: 'Pine Ridge',
  description: 'Conifers fading into morning mist. Depth from occlusion, not shading.',
  badge: 'Window',
  kind: 'world',
  minFarM: 700,
  create: createPineRidge,
}

const BASE_EYE_HEIGHT_M = 0.35
const EYE_HEIGHT_PER_DEPTH = 0.5
const FOG_COLOR = 0xa8b8c4

function createPineRidge(ctx: SceneContext): SceneInstance {
  const root = new Group()
  root.name = 'pine-ridge'

  const sky = createSkyDome({
    // Low sun, heavy air: the classic damp-morning look, and it keeps the
    // sky pale enough that the tree silhouettes carry the image.
    elevationDeg: 9,
    azimuthDeg: 158,
    turbidity: 9,
    rayleigh: 1.1,
    mieCoefficient: 0.012,
    mieDirectionalG: 0.86,
    cloudCoverage: 0.62,
    cloudDensity: 0.55,
    cloudSpeed: 0.00004,
  })
  root.add(sky.object)

  root.add(new HemisphereLight(0xd2e0ea, 0x3a4430, 2.1))

  const sun = new DirectionalLight(0xffe2bc, 1.9)
  sun.position.copy(sky.sunDirection).multiplyScalar(60)
  root.add(sun, sun.target)

  // ── Terrain ───────────────────────────────────────────────────────────────
  const heightAt = rollingHeightField(0x7c21, {
    amplitudeM: 13,
    scaleM: 160,
    taperFromM: 170,
    taperToM: 320,
  })
  const litter = fbm2D(0x33ce, { octaves: 3, frequency: 1 / 11 })

  const needleDark = new Color(0x2a3320)
  const needleLight = new Color(0x4d5236)
  const rock = new Color(0x5c5b52)

  const ground = createGround({
    heightAt,
    outerRadiusM: 330,
    colorAt(x, z, _height, slope, target) {
      const patch = (litter(x, z) + 1) / 2
      target.copy(needleDark).lerp(needleLight, patch)
      if (slope > 0.4) target.lerp(rock, Math.min(1, (slope - 0.4) * 2))
    },
  })

  // ── Trees ─────────────────────────────────────────────────────────────────
  const trunkGeometry = new CylinderGeometry(0.5, 0.85, 1, 6)
  trunkGeometry.translate(0, 0.5, 0)
  const canopyGeometry = conifer()

  const trunkMaterial = new MeshStandardMaterial({ roughness: 1, metalness: 0 })
  const canopyMaterial = new MeshStandardMaterial({
    roughness: 1,
    metalness: 0,
    flatShading: true,
  })

  // Trunks and canopies are drawn as two instanced meshes but describe one set
  // of trees, so the placements are generated once and both meshes read from
  // that list. Running the sampler twice with a shared seed would look like it
  // works and quietly desynchronise: the two passes draw different numbers of
  // random values per instance, so their streams diverge after the first tree
  // and every canopy ends up over someone else's trunk.
  const trees = sampleTrees(0x51ce, 820, heightAt)

  const trunks = instancedFromTrees(trees, trunkGeometry, trunkMaterial, (dummy, tree) => {
    dummy.position.set(tree.x, tree.y, tree.z)
    dummy.rotation.set(0, tree.spin, 0)
    dummy.scale.set(tree.height * 0.028, tree.height * 0.75, tree.height * 0.028)
  }, (tree, target) => {
    target.setRGB(0.09 + tree.tone * 0.05, 0.062 + tree.tone * 0.035, 0.045 + tree.tone * 0.02)
  })
  trunks.name = 'trunks'

  const canopies = instancedFromTrees(trees, canopyGeometry, canopyMaterial, (dummy, tree) => {
    dummy.position.set(tree.x, tree.y + tree.height * 0.36, tree.z)
    dummy.rotation.set(0, tree.spin, 0)
    dummy.scale.set(tree.spread, tree.height * 0.7, tree.spread)
  }, (tree, target) => {
    target.setRGB(0.05 + tree.tone * 0.05, 0.13 + tree.tone * 0.09, 0.06 + tree.tone * 0.04)
  })
  canopies.name = 'canopies'

  // ── Undergrowth ───────────────────────────────────────────────────────────
  const grass: GrassField = createGrassField({
    heightAt,
    count: 26000,
    seed: 0x9911,
    minRadiusM: 2,
    maxRadiusM: 26,
    bladeHeightM: [0.14, 0.42],
    bladeWidthM: 0.03,
    baseColor: 0x24331a,
    tipColor: 0x5f7a3c,
    windStrength: 0.07,
    windSpeed: 0.6,
  })

  // ── Window ────────────────────────────────────────────────────────────────
  const reveal = createWindowReveal({ depthM: 0.085, color: 0xcfc9bd, sillColor: 0x9a938a })
  reveal.layout(ctx)
  root.add(reveal.group)

  const world = new Group()
  world.name = 'ridge-world'
  world.add(ground.mesh, grass.mesh, trunks, canopies)
  root.add(world)

  const layout = (c: SceneContext): void => {
    reveal.layout(c)
    const eyeHeight = BASE_EYE_HEIGHT_M + c.roomDepthM * EYE_HEIGHT_PER_DEPTH
    world.position.y = -eyeHeight
    sun.target.position.set(0, -eyeHeight, -20)
    sun.target.updateMatrixWorld()
  }
  layout(ctx)

  return {
    root,
    // Thicker than the meadow's: mist is the whole mood, and it means the
    // 110m tree limit never shows as an edge.
    fog: new FogExp2(FOG_COLOR, 0.019),
    exposure: 0.62,
    environmentIntensity: 0.1,
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
      trunkGeometry.dispose()
      canopyGeometry.dispose()
    },
  }
}

/**
 * Three stacked cones, merged into one geometry.
 *
 * Most of these canopies are seen from underneath, and a single cone shows you
 * its base cap — a flat green disc, which from below looks like a sheet of
 * paper hung in the air. Tiers give overlapping silhouette edges instead, for
 * the price of a few hundred extra triangles and no extra draw call.
 */
function conifer(): BufferGeometry {
  const tiers = [
    { base: 0, radius: 1, height: 0.52 },
    { base: 0.34, radius: 0.76, height: 0.44 },
    { base: 0.64, radius: 0.5, height: 0.38 },
  ]
  const parts = tiers.map(({ base, radius, height }) => {
    const cone = new ConeGeometry(radius, height, 8)
    cone.translate(0, base + height / 2, 0)
    return cone
  })
  const merged = mergeGeometries(parts)!
  for (const part of parts) part.dispose()
  return merged
}

interface Tree {
  x: number
  y: number
  z: number
  height: number
  spread: number
  spin: number
  /** 0–1 colour jitter, shared by trunk and canopy. */
  tone: number
}

function sampleTrees(seed: number, count: number, heightAt: Noise2D): Tree[] {
  const random = rng(seed)
  const trees: Tree[] = []
  // The window is only ~18° tall, so a mature conifer never fits inside it at
  // any believable distance. Rather than shrink the trees into bushes, the
  // nearest is set far enough back that its trunk reads as a trunk — the
  // canopy simply leaves the top of the frame, which is what standing among
  // real trees looks like.
  const minRadius = 14
  const maxRadius = 110

  while (trees.length < count) {
    const angle = random() * Math.PI * 2
    // Uniform by area, unlike the grass. Trees have a real-world density —
    // roughly one every six metres — and log-radial sampling would pile
    // hundreds of them into the near field, fusing into a solid wall of bark.
    const radius = Math.sqrt(
      minRadius * minRadius + random() * (maxRadius * maxRadius - minRadius * minRadius),
    )
    const x = Math.cos(angle) * radius
    const z = Math.sin(angle) * radius
    const height = 15 + random() * 11
    const spread = height * (0.15 + random() * 0.06)
    const spin = random() * Math.PI
    const tone = random()
    trees.push({ x, y: heightAt(x, z), z, height, spread, spin, tone })
  }
  return trees
}

function instancedFromTrees(
  trees: readonly Tree[],
  geometry: BufferGeometry,
  material: MeshStandardMaterial,
  place: (dummy: Object3D, tree: Tree) => void,
  colorAt: (tree: Tree, target: Color) => void,
): InstancedMesh {
  const mesh = new InstancedMesh(geometry, material, trees.length)
  mesh.frustumCulled = false
  const dummy = new Object3D()
  const color = new Color()

  trees.forEach((tree, i) => {
    place(dummy, tree)
    dummy.updateMatrix()
    mesh.setMatrixAt(i, dummy.matrix)
    colorAt(tree, color)
    mesh.setColorAt(i, color)
  })

  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  return mesh
}
