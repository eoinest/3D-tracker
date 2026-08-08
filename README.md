# 3D Tracker

Your webcam watches where your head is. The renderer moves the camera to match and shears
its frustum to stay pinned to the edges of your display. The result is that the screen
stops behaving like a picture of a scene and starts behaving like a hole in the wall —
lean left and you see around the left side of things, lean in and you see deeper into the
room.

No glasses, no VR headset, one eye's worth of parallax. It only works for one viewer at a
time, and only for the viewer whose head is being tracked, but for that person it is
surprisingly convincing.

```
npm install
npm run dev
```

Then open the printed URL and press **Start camera**.

---

## How it works

Three pieces, each of which has to be right or the illusion collapses:

**1. Off-axis projection** (`src/core/offAxis.ts`)

A normal 3D camera has a symmetric frustum glued to its own axis: rotating it swings the
whole world, and moving your head does nothing at all. Here the frustum is pinned to a
fixed rectangle in the world — the physical screen — and *sheared* so its apex lands
wherever your eye is. The camera translates with your head and never rotates.

This is Robert Kooima's generalised perspective projection, reduced to the axis-aligned
case: the screen lies in the plane `z = 0`, `+X` is right, `+Y` is up, `+Z` points out of
the glass at you, and the whole derivation collapses to an asymmetric frustum:

```
left   = (-halfWidth  - eyeX) · near / eyeZ
right  = ( halfWidth  - eyeX) · near / eyeZ
bottom = (-halfHeight - eyeY) · near / eyeZ
top    = ( halfHeight - eyeY) · near / eyeZ
```

The defining property — and what `test/offAxis.test.ts` checks — is that the four corners
of the physical window project to the four corners of the viewport from *any* eye
position. That is what nails the virtual world to the glass.

**2. Head tracking** (`src/core/headTracker.ts`, `src/core/pinhole.ts`)

MediaPipe's Face Landmarker gives 478 landmarks per frame, including the iris centres.
Two of those are a near-rigid pair whose real-world separation you already know — your
interpupillary distance, about 63mm — so the pinhole relation gives distance directly:

```
z = interpupillaryDistance · focalLength / apparentSeparation
```

and the midpoint of the pair back-projects to give x and y.

The apparent separation is measured in **3D**, not 2D. When you turn your head the
projected gap between the irises narrows, and a 2D measurement would read that as you
having moved a foot backwards. MediaPipe's per-landmark `z` is on roughly the same scale
as `x`, so including it makes the estimate nearly yaw-invariant.

**3. Smoothing** (`src/core/oneEuro.ts`)

Head tracking has the classic jitter-versus-lag tradeoff, and it is unusually punishing
here: a fixed low-pass filter strong enough to kill the shimmer when you sit still also
smears the geometry when you lunge sideways, which is exactly the moment the illusion
needs to be crisp. The [1€ filter](https://gery.casiez.net/1euro/) adapts its cutoff to
speed — heavy smoothing when slow, almost none when fast.

## Calibration

The illusion is geometry, not guesswork. Three numbers have to match reality, and the
**Calibration** panel exists to set them:

| Setting | Why it matters |
| --- | --- |
| **Screen diagonal** | Sets the physical size of the projection window. Wrong here and the world shears as you move. |
| **Camera above screen** | Distance from the top edge of the *picture* to the webcam lens. Wrong here and vertical parallax is offset. |
| **Webcam focal length** | Sets the depth scale. Don't guess it — use the measurement below. |

To measure focal length: start the camera, sit at a distance you can actually measure with
a tape, type that distance into **Measure at**, and press **Set**. That solves for the
focal length from the iris separation the tracker is currently seeing, which is far more
reliable than trying to look up your webcam's field of view.

Check your work with the **Infinite Tunnel** scene. Its frames are concentric with the
window and exactly its size, so when calibration is right they stay nested and square no
matter where your head goes. If the corridor shears or swims, something above is wrong.

Two more things affect accuracy:

- **Fullscreen (F) is better.** Outside fullscreen the app has to guess where the browser
  window sits on your display, from `window.screenX/screenY` and the height of the browser
  chrome. It is usually close. On a multi-monitor setup it can be well off — switch
  **Canvas position** to "Fills screen" and go fullscreen.
- **Your actual eye spacing.** The 63mm default is an adult mean. If the reported distance
  is consistently off by a fixed percentage, this is the knob.

## Scenes

| | |
| --- | --- |
| **Portal Room** | A lit box behind the glass with objects scattered through its depth. The reference demo. |
| **Infinite Tunnel** | Concentric frames rushing past. Doubles as the calibration target. |
| **Top-Down Arena** | A game level as a tilted diorama. **WASD** to drive. |
| **Star Field** | Pure parallax — no occlusion, no shading, no familiar objects. If depth reads here, the tracking is doing real work. |
| **Sample models** | Procedural objects on a pedestal, for checking the model viewer without uploading anything. |

### Why the arena is the interesting one

A fixed top-down camera in a game loses everything behind a wall. The usual fixes are
transparency hacks, dithering, or a camera the player has to fight. With head tracking you
just lean, and the parallax shows you what's behind the wall — the occlusion problem
solves itself, because the viewer's eye becomes a real degree of freedom instead of a
fixed assumption baked into the render.

## Loading your own models

Drop files anywhere on the page, or use the upload box in the library.

Supported: **`.glb` `.gltf` `.obj` `.fbx` `.stl` `.ply`**, with Draco, Meshopt and KTX2
compression handled for glTF.

Multi-file assets work: drop the `.gltf` together with its `.bin` and its textures, or drop
the whole folder. Every file gets a blob URL and the loader rewrites relative references to
match, which is what makes a folder drop resolve. An `.mtl` next to an `.obj` is picked up
automatically.

Models are normalised into the room rather than shown at their authored scale — a 40-metre
CAD assembly and a 2-centimetre trinket both need to end up a few centimetres tall to fit
inside a window the size of a laptop screen. `.obj`/`.fbx`/`.stl`/`.ply` also get a Z-up
correction when their bounding box says they're lying down; glTF is the only one of the set
that guarantees Y-up.

## Controls

| Key | |
| --- | --- |
| `H` | hide / show the panel |
| `F` | fullscreen |
| `C` | start / stop the camera |
| `D` | tracking overlay |
| `P` | switch between camera and pointer |
| `WASD` | drive the player (Top-Down Arena) |

**Pointer mode** fakes a viewer with the mouse — no camera, no permission prompt. Useful
for demos, screenshots, and for checking whether something is a tracking problem or a
rendering problem. Scroll to change the virtual viewing distance.

Two settings worth knowing about:

- **Content: Window vs Pop-out.** Window mode puts a clipping plane at `z = 0`, so nothing
  can cross the glass. Pop-out removes it and lets geometry come out at you.
- **Parallax gain.** `1×` is physically true. Above that exaggerates the effect, which is
  more impressive on a small screen and more nauseating on a large one.

## Privacy

Video never leaves the machine. The camera stream goes into a MediaPipe wasm module running
in the page, and only the resulting head coordinates are used. There is no server, no
analytics, and no network traffic at runtime beyond the initial page load. Settings live in
`localStorage`.

The one exception is the face landmark model, fetched once from Google's CDN. To self-host
it, download
[`face_landmarker.task`](https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task)
into `public/mediapipe/` — the app prefers a local copy when it finds one. Or set
`VITE_FACE_MODEL_URL` to point somewhere else entirely.

## Project layout

```
src/
  core/
    offAxis.ts       the projection math — the whole trick
    pinhole.ts       landmarks -> eye position (dependency-free, unit tested)
    headTracker.ts   webcam + MediaPipe, wrapping pinhole.ts
    oneEuro.ts       1€ filter
    screen.ts        physical display geometry, in metres
    viewer.ts        renderer, scene lifecycle, off-axis camera
    modelLoader.ts   multi-file model loading
    settings.ts      persisted state
  scenes/            the worlds, plus the pedestal showcase used for uploads
  ui/                panel, controls, debug overlay (no framework)
test/                node --test, no test runner dependency
```

## Commands

```
npm run dev        dev server
npm run build      typecheck + test + production build
npm test           unit tests (node --test, native TS stripping)
npm run typecheck  tsc --noEmit
npm run preview    serve the production build
```

`npm run sync:vendor` copies MediaPipe's wasm runtime out of `node_modules` into `public/`,
and runs automatically before `dev` and `build`. It exists because
`FilesetResolver.forVisionTasks()` takes a runtime URL the bundler never sees, so the wasm
has to be served as a static asset — and pinning it to the installed package version avoids
the failure mode where bundled JS and CDN wasm drift apart between releases.

## Requirements

A browser with WebGL2 and `getUserMedia`, which means a secure context: `https://` or
`localhost`. To test from a phone on your LAN you'll need a tunnel or a local TLS cert;
plain `http://192.168.x.x` will not get you a camera.

## Credits

- Kooima, R. — *Generalized Perspective Projection* (2008)
- Casiez, Roussel & Vogel — *1€ Filter* (CHI 2012)
- [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)
- [three.js](https://threejs.org)

Johnny Lee's 2007 Wii-remote head tracking demo is the ancestor of all of this.

## License

MIT
