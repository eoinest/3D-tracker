import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  calibrateMetersPerUnit,
  headPoseFromMatrix,
  type HeadPoseOptions,
} from '../src/core/headPose.ts'
import { VelocityPredictor } from '../src/core/predict.ts'

const BASE: HeadPoseOptions = {
  metersPerUnit: 0.01,
  mirror: true,
  cameraXM: 0,
  cameraYM: 0.103,
  cameraZM: 0,
}

/** Column-major 4×4 with an identity rotation and the given translation. */
function poseMatrix(tx: number, ty: number, tz: number): number[] {
  // prettier-ignore
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    tx, ty, tz, 1,
  ]
}

test('translation is read from the matrix and scaled to metres', () => {
  // MediaPipe works in centimetres with the face at negative z.
  const pose = headPoseFromMatrix(poseMatrix(0, 0, -60), BASE)!
  assert.ok(Math.abs(pose.z - 0.6) < 1e-9, `z=${pose.z}`)
})

test('a centred face sits directly in front of the camera', () => {
  const pose = headPoseFromMatrix(poseMatrix(0, 0, -55), BASE)!
  assert.ok(Math.abs(pose.x - BASE.cameraXM) < 1e-12)
  assert.ok(Math.abs(pose.y - BASE.cameraYM) < 1e-12)
})

test('a mirrored camera maps image-right to viewer-left', () => {
  const right = headPoseFromMatrix(poseMatrix(20, 0, -55), BASE)!
  assert.ok(right.x < 0, `x=${right.x}`)
  assert.ok(headPoseFromMatrix(poseMatrix(20, 0, -55), { ...BASE, mirror: false })!.x > 0)
})

test('a face above the camera axis maps to a viewer above it', () => {
  const pose = headPoseFromMatrix(poseMatrix(0, 12, -55), BASE)!
  assert.ok(pose.y > BASE.cameraYM, `y=${pose.y}`)
})

test('degenerate matrices are rejected rather than propagated', () => {
  assert.equal(headPoseFromMatrix([1, 2, 3], BASE), null)
  assert.equal(headPoseFromMatrix(poseMatrix(0, 0, NaN), BASE), null)
  // A face at the lens is not a face.
  assert.equal(headPoseFromMatrix(poseMatrix(0, 0, 0), BASE), null)
})

test('calibration solves the single unknown scale', () => {
  const matrix = poseMatrix(0, 0, -48)
  const k = calibrateMetersPerUnit(matrix, 0.6)!
  const pose = headPoseFromMatrix(matrix, { ...BASE, metersPerUnit: k })!
  assert.ok(Math.abs(pose.z - 0.6) < 1e-9, `z=${pose.z}`)
})

test('the sign convention survives a yawed head', () => {
  // 30° yaw about Y, still translated to the viewer's right of the lens.
  const c = Math.cos(Math.PI / 6)
  const s = Math.sin(Math.PI / 6)
  // prettier-ignore
  const matrix = [
    c, 0, -s, 0,
    0, 1, 0, 0,
    s, 0, c, 0,
    18, 0, -55, 1,
  ]
  const pose = headPoseFromMatrix(matrix, BASE)!
  // Position must depend only on the translation, never on the rotation.
  const upright = headPoseFromMatrix(poseMatrix(18, 0, -55), BASE)!
  assert.ok(Math.abs(pose.x - upright.x) < 1e-12)
  assert.ok(Math.abs(pose.z - upright.z) < 1e-12)
  assert.ok(Math.abs(pose.yaw) > 0.4, `yaw=${pose.yaw}`)
})

test('prediction leads a steady movement without overshooting the clamp', () => {
  const predictor = new VelocityPredictor({ maxOffsetM: 0.07 })

  // 0.3 m/s to the right, sampled at 60Hz for a second.
  let x = 0
  for (let i = 0; i < 60; i++) {
    x = i * (0.3 / 60)
    predictor.update(x, 0, 0.6, i / 60)
  }

  const lead = 0.05
  const predicted = predictor.predict({ x, y: 0, z: 0.6 }, lead)
  // Should lead by roughly velocity × lead = 15mm, and never by more than the
  // clamp however fast the head is moving.
  assert.ok(predicted.x > x + 0.008, `expected lead, got ${predicted.x - x}`)
  assert.ok(predicted.x < x + 0.02, `over-predicted: ${predicted.x - x}`)
  assert.ok(Math.abs(predictor.speed - 0.3) < 0.05, `speed=${predictor.speed}`)
})

test('prediction is clamped so a fast lunge cannot fling the scene', () => {
  const predictor = new VelocityPredictor({ maxOffsetM: 0.07 })
  for (let i = 0; i < 60; i++) predictor.update(i * (8 / 60), 0, 0.6, i / 60)

  const predicted = predictor.predict({ x: 8, y: 0, z: 0.6 }, 0.25)
  assert.ok(predicted.x <= 8 + 0.07 + 1e-9, `clamp breached: ${predicted.x - 8}`)
})

test('a zero lead, or no history, returns the position untouched', () => {
  const predictor = new VelocityPredictor()
  const at = { x: 0.1, y: 0.2, z: 0.6 }
  assert.deepEqual(predictor.predict(at, 0.05), at)

  predictor.update(0.1, 0.2, 0.6, 0)
  assert.deepEqual(predictor.predict(at, 0), at)
})

test('repeated timestamps do not divide by zero', () => {
  const predictor = new VelocityPredictor()
  predictor.update(0, 0, 0.6, 1)
  predictor.update(0.5, 0, 0.6, 1)
  const predicted = predictor.predict({ x: 0.5, y: 0, z: 0.6 }, 0.05)
  assert.ok(Number.isFinite(predicted.x), `non-finite: ${predicted.x}`)
  assert.equal(predicted.x, 0.5)
})
