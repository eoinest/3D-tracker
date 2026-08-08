import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PerspectiveCamera, Vector3 } from 'three'

import { applyOffAxisCamera, offAxisProjection, type WindowRect } from '../src/core/offAxis.ts'

/**
 * The defining property of an off-axis projection: the corners of the physical
 * window always land exactly on the edges of the viewport, no matter where the
 * eye is. That is what pins the virtual world to the glass — if it drifts, the
 * scene stops looking like a room and starts looking like a wobbling picture.
 */

const NEAR = 0.02
const FAR = 60

function corners(win: WindowRect): Vector3[] {
  const hw = win.widthM / 2
  const hh = win.heightM / 2
  return [
    new Vector3(win.centerXM - hw, win.centerYM - hh, 0),
    new Vector3(win.centerXM + hw, win.centerYM - hh, 0),
    new Vector3(win.centerXM + hw, win.centerYM + hh, 0),
    new Vector3(win.centerXM - hw, win.centerYM + hh, 0),
  ]
}

const EYES = [
  new Vector3(0, 0, 0.55),
  new Vector3(0.22, 0.13, 0.42),
  new Vector3(-0.3, -0.18, 0.9),
  new Vector3(0.05, -0.4, 0.25),
  new Vector3(-0.9, 0.6, 1.8),
]

const WINDOWS: WindowRect[] = [
  { widthM: 0.31, heightM: 0.19, centerXM: 0, centerYM: 0 },
  // Browser window parked off to one side of the display.
  { widthM: 0.18, heightM: 0.12, centerXM: -0.06, centerYM: 0.03 },
  // A large monitor.
  { widthM: 0.6, heightM: 0.34, centerXM: 0, centerYM: 0 },
]

test('window corners project to the viewport edges from any eye position', () => {
  for (const win of WINDOWS) {
    for (const eye of EYES) {
      const camera = new PerspectiveCamera()
      applyOffAxisCamera(camera, eye, win, NEAR, FAR)

      for (const corner of corners(win)) {
        const ndc = corner.clone().project(camera)
        assert.ok(
          Math.abs(Math.abs(ndc.x) - 1) < 1e-6,
          `x ndc ${ndc.x} for eye ${eye.toArray()} window ${win.widthM}`,
        )
        assert.ok(
          Math.abs(Math.abs(ndc.y) - 1) < 1e-6,
          `y ndc ${ndc.y} for eye ${eye.toArray()} window ${win.widthM}`,
        )
      }
    }
  }
})

test('the window centre stays at the viewport centre', () => {
  for (const win of WINDOWS) {
    for (const eye of EYES) {
      const camera = new PerspectiveCamera()
      applyOffAxisCamera(camera, eye, win, NEAR, FAR)

      const centre = new Vector3(win.centerXM, win.centerYM, 0).project(camera)
      assert.ok(Math.abs(centre.x) < 1e-6, `x ${centre.x}`)
      assert.ok(Math.abs(centre.y) < 1e-6, `y ${centre.y}`)
    }
  }
})

test('the camera never rotates', () => {
  const camera = new PerspectiveCamera()
  applyOffAxisCamera(camera, new Vector3(0.4, -0.25, 0.3), WINDOWS[0]!, NEAR, FAR)

  assert.deepEqual(camera.quaternion.toArray().map(Math.round), [0, 0, 0, 1])
  assert.equal(camera.position.x, 0.4)
  assert.equal(camera.position.y, -0.25)
})

test('an eye at or behind the glass is clamped to a usable distance', () => {
  const win = WINDOWS[0]!
  for (const z of [0, -0.5, 0.001]) {
    const matrix = offAxisProjection({ x: 0, y: 0, z }, win, NEAR, FAR)
    for (const value of matrix.elements) {
      assert.ok(Number.isFinite(value), `non-finite projection element for z=${z}`)
    }
  }
})

test('leaning right reveals more of the left wall', () => {
  const win = WINDOWS[0]!
  // A point on the back wall, off to the left of the room.
  const target = new Vector3(-0.14, 0, -0.9)

  const centred = new PerspectiveCamera()
  applyOffAxisCamera(centred, new Vector3(0, 0, 0.55), win, NEAR, FAR)

  const leaning = new PerspectiveCamera()
  applyOffAxisCamera(leaning, new Vector3(0.12, 0, 0.55), win, NEAR, FAR)

  // Moving the eye right pushes distant left-hand geometry further right on
  // screen — the parallax shift that sells the illusion.
  assert.ok(target.clone().project(leaning).x > target.clone().project(centred).x)
})
