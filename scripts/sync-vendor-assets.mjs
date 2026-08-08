// Copies MediaPipe's wasm runtime out of node_modules and into public/, so it
// is served from our own origin at the exact version we installed.
//
// MediaPipe needs this because `FilesetResolver.forVisionTasks()` takes a plain
// runtime URL that the bundler never sees. (three's Draco and KTX2 loaders do
// not need the same treatment — they reference their payloads with
// `new URL(..., import.meta.url)`, which Vite resolves at build time.)
//
// Pointing MediaPipe at a CDN instead is the classic source of "works on my
// machine": the bundled JS and the remote wasm drift apart on the next release
// and the app dies at runtime with an opaque abort().
import { cp, mkdir, rm, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** @type {{ from: string, to: string, label: string, optional?: boolean }[]} */
const COPIES = [
  {
    label: 'MediaPipe vision wasm',
    from: 'node_modules/@mediapipe/tasks-vision/wasm',
    to: 'public/mediapipe/wasm',
  },
]

let failed = false
for (const { label, from, to, optional } of COPIES) {
  const src = resolve(root, from)
  const dest = resolve(root, to)
  try {
    await stat(src)
  } catch {
    if (optional) continue
    console.error(`[sync] missing ${from} — run \`npm install\` first.`)
    failed = true
    continue
  }
  await rm(dest, { recursive: true, force: true })
  await mkdir(dirname(dest), { recursive: true })
  await cp(src, dest, { recursive: true })
  console.log(`[sync] ${label} -> ${to}`)
}

if (failed) process.exit(1)
