import type { Object3D, Scene, WebGLRenderer } from 'three'

/**
 * Lazy loader for the Gaussian splat renderer.
 *
 * Spark is by far the largest dependency here — several megabytes with its
 * workers and wasm. Most sessions never open a capture, so importing it
 * statically would make everyone pay for the Portal Room. This defers the whole
 * thing to the first time a splat scene is actually mounted.
 */

type SparkModule = typeof import('@sparkjsdev/spark')

let modulePromise: Promise<SparkModule> | null = null
let sparkRenderer: Object3D | null = null
let host: { renderer: WebGLRenderer; scene: Scene } | null = null

/** Called once by the viewer so the runtime knows where to attach itself. */
export function registerSplatHost(renderer: WebGLRenderer, scene: Scene): void {
  host = { renderer, scene }
}

export function loadSparkModule(): Promise<SparkModule> {
  modulePromise ??= import('@sparkjsdev/spark')
  return modulePromise
}

/**
 * Loads Spark and attaches its renderer to the scene, once.
 *
 * The SparkRenderer has to be in the scene graph for splats to draw at all, but
 * adding it when no splats exist costs a sort pass per frame for nothing.
 */
export async function ensureSparkRenderer(): Promise<SparkModule> {
  const spark = await loadSparkModule()
  if (!sparkRenderer && host) {
    sparkRenderer = new spark.SparkRenderer({ renderer: host.renderer })
    host.scene.add(sparkRenderer)
  }
  return spark
}
