import type { Object3D, WebGLRenderer } from 'three'

import type { Settings } from '../core/settings'

/**
 * Everything a scene needs to size itself to the *physical* window.
 *
 * Scenes are built in metres and are expected to line their front edge up with
 * z = 0 — the plane of the glass. Content that crosses z = 0 pokes out of the
 * screen, which is either the point (popout mode) or a bug (window mode, where
 * a clipping plane hides it).
 */
export interface SceneContext {
  /** Physical size of the canvas viewport, in metres. */
  windowWidthM: number
  windowHeightM: number
  /** How far back the world should extend, in metres. */
  roomDepthM: number
  settings: Readonly<Settings>
  renderer: WebGLRenderer
}

export interface SceneInstance {
  root: Object3D
  /** Per-frame animation. `dt` and `elapsed` are seconds. */
  update?(dt: number, elapsed: number, ctx: SceneContext): void
  /** Called when the window's physical size or the room depth changes. */
  resize?(ctx: SceneContext): void
  /** Optional keyboard hook; return true to swallow the event. */
  onKey?(event: KeyboardEvent, down: boolean): boolean
  dispose?(): void
}

export interface SceneDefinition {
  id: string
  name: string
  description: string
  /** Short badge shown in the library list. */
  badge?: string
  /** Set for entries that are really "a model on a pedestal". */
  kind: 'world' | 'model'
  create(ctx: SceneContext): SceneInstance
}
