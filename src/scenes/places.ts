import { NEUTRAL_PLACEMENT, splatPlaceScene, type SplatPlaceMeta } from './splatPlace'
import type { SceneDefinition } from './types'

/**
 * Real captured places, loaded as 3D Gaussian splats.
 *
 * These are *linked*, never redistributed — each is fetched at runtime from the
 * host that publishes it, and the credit shows in the panel. They come from the
 * public demo assets of Spark (World Labs), the MIT-licensed splat renderer
 * this app uses; the same files its own examples load.
 *
 * The set is small and deliberately so. Most freely-linkable splats are object
 * scans, not places, and the ones that are places vary wildly — a 500k-splat
 * capture of a whole street is genuinely soft when you stand inside it, however
 * it is framed. The URL box in the Library is the real answer here: point it at
 * a good capture and it will be better than anything that could be shipped.
 *
 * Nothing here is authored by this project, deliberately. A procedural meadow
 * is recognisably a procedural meadow no matter how many blades you instance,
 * and the whole point of a window is that what's on the other side of it looks
 * like somewhere that exists.
 *
 * Each capture needs a hand-tuned placement because scans carry no agreed scale
 * or up-axis. `npm run dev` plus the Placement panel is how these were found.
 */

const SPARK_CREDIT = 'Spark demo scene · World Labs'
const SPARK_CREDIT_URL = 'https://sparkjs.dev/'

const CAPTURES: SplatPlaceMeta[] = [
  {
    id: 'place:valley',
    name: 'Valley',
    description: 'An open landscape. Big depth range — the best parallax of the set.',
    url: 'https://sparkjs.dev/assets/splats/valley.spz',
    credit: SPARK_CREDIT,
    creditUrl: SPARK_CREDIT_URL,
    sizeMB: 6.4,
    badge: 'Start here',
    placement: { ...NEUTRAL_PLACEMENT },
  },
  {
    id: 'place:snow-street',
    name: 'Snow Street',
    description: 'A street after snowfall. Strong near-to-far structure down the road.',
    url: 'https://sparkjs.dev/assets/splats/snow-street.spz',
    credit: SPARK_CREDIT,
    creditUrl: SPARK_CREDIT_URL,
    sizeMB: 9.5,
    // Raised, so the road falls away below the sill instead of filling the
    // lower two thirds of the frame with empty snow.
    placement: { ...NEUTRAL_PLACEMENT, offsetYM: 1.4 },
  },
]

export const PLACE_CAPTURES: readonly SplatPlaceMeta[] = CAPTURES

export const PLACE_SCENES: readonly SceneDefinition[] = CAPTURES.map(splatPlaceScene)

export function findCapture(id: string): SplatPlaceMeta | undefined {
  return CAPTURES.find((capture) => capture.id === id)
}

/** Wraps a user-supplied splat URL or dropped file into a scene. */
export function customSplatScene(meta: {
  id: string
  name: string
  url: string
  sizeMB?: number
}): SceneDefinition {
  return splatPlaceScene({
    ...meta,
    description: 'Your capture. Use Placement below to seat it in the window.',
    credit: 'Loaded by you',
    badge: 'Custom',
    placement: { ...NEUTRAL_PLACEMENT },
  })
}
