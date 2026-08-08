import assert from 'node:assert/strict'
import { test } from 'node:test'

import { eyeFromLandmarkPair, type PinholeOptions } from '../src/core/pinhole.ts'
import { OneEuroFilter } from '../src/core/oneEuro.ts'

const BASE: PinholeOptions = {
  videoWidth: 1280,
  videoHeight: 720,
  baselineM: 0.063,
  focalNorm: 0.85,
  mirror: true,
  cameraXM: 0,
  // Webcam sits above the top edge of a 19cm-tall picture.
  cameraYM: 0.103,
  cameraZM: 0,
}

/** Places an iris pair at a given image midpoint and pixel separation. */
function pair(u: number, v: number, separationPx: number, dz = 0) {
  const half = separationPx / 2 / BASE.videoWidth
  return [
    { x: u - half, y: v, z: dz / 2 },
    { x: u + half, y: v, z: -dz / 2 },
  ] as const
}

test('distance follows the inverse of apparent eye separation', () => {
  const focalPx = BASE.focalNorm * BASE.videoWidth
  // z = baseline · focal / separation, so pick a separation for a target z.
  const expected = 0.6
  const separation = (BASE.baselineM * focalPx) / expected

  const [a, b] = pair(0.5, 0.5, separation)
  const eye = eyeFromLandmarkPair(a, b, BASE)!

  assert.ok(Math.abs(eye.z - expected) < 1e-9, `z=${eye.z}`)

  // Twice as far away looks half as wide.
  const [c, d] = pair(0.5, 0.5, separation / 2)
  assert.ok(Math.abs(eyeFromLandmarkPair(c, d, BASE)!.z - expected * 2) < 1e-9)
})

test('a face centred in frame sits directly in front of the camera', () => {
  const [a, b] = pair(0.5, 0.5, 130)
  const eye = eyeFromLandmarkPair(a, b, BASE)!

  assert.ok(Math.abs(eye.x - BASE.cameraXM) < 1e-12, `x=${eye.x}`)
  assert.ok(Math.abs(eye.y - BASE.cameraYM) < 1e-12, `y=${eye.y}`)
})

test('a mirrored camera maps image-right to viewer-left', () => {
  // Appearing on the right of the raw image means you moved to *your* left.
  const [a, b] = pair(0.7, 0.5, 130)
  assert.ok(eyeFromLandmarkPair(a, b, BASE)!.x < 0)
  assert.ok(eyeFromLandmarkPair(a, b, { ...BASE, mirror: false })!.x > 0)
})

test('a face low in frame maps to a viewer below the camera', () => {
  const [a, b] = pair(0.5, 0.8, 130)
  assert.ok(eyeFromLandmarkPair(a, b, BASE)!.y < BASE.cameraYM)
})

test('turning your head does not fake a change in distance', () => {
  const focalPx = BASE.focalNorm * BASE.videoWidth
  const separation = (BASE.baselineM * focalPx) / 0.6

  // A yawed head: the projected gap narrows, but the landmarks separate in z,
  // so the 3D separation — and therefore the distance — should hold up.
  const yawed = 0.8
  const [a, b] = pair(0.5, 0.5, separation * yawed, (separation * Math.sqrt(1 - yawed ** 2)) / BASE.videoWidth)
  const straight = pair(0.5, 0.5, separation)

  const yawedZ = eyeFromLandmarkPair(a, b, BASE)!.z
  const straightZ = eyeFromLandmarkPair(straight[0], straight[1], BASE)!.z
  assert.ok(Math.abs(yawedZ - straightZ) < 1e-9, `${yawedZ} vs ${straightZ}`)

  // A naive 2D estimate would have read 25% further away.
  const naive = eyeFromLandmarkPair(
    { x: a.x, y: a.y },
    { x: b.x, y: b.y },
    BASE,
  )!.z
  assert.ok(naive > straightZ * 1.2, `2D estimate should overshoot, got ${naive}`)
})

test('sub-pixel separations are rejected rather than exploding', () => {
  const [a, b] = pair(0.5, 0.5, 0.4)
  assert.equal(eyeFromLandmarkPair(a, b, BASE), null)
})

test('the 1€ filter converges on a held value and tracks a ramp', () => {
  const filter = new OneEuroFilter({ minCutoff: 1.2, beta: 0.035 })

  let held = 0
  for (let i = 0; i < 200; i++) held = filter.filter(0.5, i / 60)
  assert.ok(Math.abs(held - 0.5) < 1e-3, `settled at ${held}`)

  // Following a fast ramp should lag, but by well under the distance moved.
  let tracked = held
  for (let i = 200; i < 260; i++) tracked = filter.filter(0.5 + (i - 200) * 0.01, i / 60)
  const truth = 0.5 + 59 * 0.01
  assert.ok(tracked > 0.8, `should have followed the ramp, got ${tracked}`)
  assert.ok(tracked < truth, 'should still lag slightly behind the raw signal')
})
