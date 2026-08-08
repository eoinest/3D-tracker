import type { Object3D } from 'three'

import { arenaScene } from './arena'
import { BUILT_IN_MODELS } from './builtinModels'
import { meadowScene } from './meadow'
import { pineRidgeScene } from './pineRidge'
import { portalRoomScene } from './portalRoom'
import { createShowcase, type ShowcaseOptions } from './showcase'
import { shoreScene } from './shore'
import { starfieldScene } from './starfield'
import { tunnelScene } from './tunnel'
import type { SceneDefinition } from './types'

export { createShowcase } from './showcase'
export type { SceneContext, SceneDefinition, SceneInstance } from './types'

/** Real-scale places, viewed through a hole in a wall. */
export const PLACE_SCENES: readonly SceneDefinition[] = [meadowScene, shoreScene, pineRidgeScene]

/** Abstract or constructed worlds that fill the aperture directly. */
export const WORLD_SCENES: readonly SceneDefinition[] = [
  portalRoomScene,
  tunnelScene,
  arenaScene,
  starfieldScene,
]

/** Wraps any Object3D factory into a pedestal scene. */
export function modelScene(
  meta: { id: string; name: string; description: string; badge?: string },
  build: () => Object3D,
  options: ShowcaseOptions = {},
): SceneDefinition {
  return {
    ...meta,
    kind: 'model',
    create: (ctx) => createShowcase(build(), ctx, options),
  }
}

export const MODEL_SCENES: readonly SceneDefinition[] = BUILT_IN_MODELS.map((model) =>
  modelScene(
    { id: `model:${model.id}`, name: model.name, description: model.description },
    model.build,
    { idleSpin: 0.25 },
  ),
)

/** Wraps a user-supplied object, which must survive scene switches. */
export function uploadScene(
  meta: { id: string; name: string; description: string },
  object: Object3D,
): SceneDefinition {
  return modelScene(meta, () => object, { keepContent: true, idleSpin: 0.15 })
}

export const BUILT_IN_SCENES: readonly SceneDefinition[] = [
  ...PLACE_SCENES,
  ...WORLD_SCENES,
  ...MODEL_SCENES,
]

export function findScene(id: string): SceneDefinition | undefined {
  return BUILT_IN_SCENES.find((scene) => scene.id === id)
}
