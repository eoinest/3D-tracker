# 3D Tracker

**[Try it →](https://3d-tracker-ten.vercel.app)** (needs a webcam; works in pointer mode without one)

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

**2. Head tracking** (`src/core/headTracker.ts`, `headPose.ts`, `pinhole.ts`)

MediaPipe's Face Landmarker gives 478 landmarks per frame plus a metric head
pose, and there are two ways to turn that into an eye position. The app has
both, switchable under **Tracking → Estimator**:

- **Face mesh** (default) reads MediaPipe's facial transformation matrix — a
  rigid fit of the whole canonical face mesh to the detected one. Hundreds of
  landmarks vote on a single 6-DoF pose, so noise largely cancels, and it is
  yaw-invariant by construction.
- **Iris** back-projects the two iris landmarks through the pinhole relation
  `z = ipd · focal / separation`. Two points out of 478, so every pixel of
  landmark noise lands on the output — but it is easy to reason about, and it
  is the fallback when no transformation matrix is available.

Both need exactly one scale factor calibrated, for the same underlying reason:
MediaPipe estimates its pose against an undocumented virtual camera whose field
of view isn't your webcam's, and a webcam doesn't report its focal length. One
measurement fixes either.

The iris estimator measures separation in **3D**, not 2D — when you turn your
head the projected gap between the irises narrows, and a 2D measurement reads
that as having moved a foot backwards.

**3. Smoothing** (`src/core/oneEuro.ts`)

Head tracking has the classic jitter-versus-lag tradeoff, and it is unusually punishing
here: a fixed low-pass filter strong enough to kill the shimmer when you sit still also
smears the geometry when you lunge sideways, which is exactly the moment the illusion
needs to be crisp. The [1€ filter](https://gery.casiez.net/1euro/) adapts its cutoff to
speed — heavy smoothing when slow, almost none when fast.

**4. Latency compensation** (`src/core/predict.ts`)

By the time a head position reaches the screen it has been through camera
exposure, USB transfer, ~10–20ms of neural network, a smoothing filter that lags
by design, a render and a display refresh. That total is typically 60–100ms, and
this illusion is unusually sensitive to it — the scene should feel welded to the
room, and lag makes it feel dragged along behind your head.

So detection runs off `requestVideoFrameCallback` rather than the render loop.
That fires once per *camera* frame, so no frame is processed twice or skipped,
and its metadata carries the frame's capture timestamp — the only way to measure
the pipeline's real latency instead of guessing. The debug overlay shows the
measured figure.

That measurement then drives a short forward extrapolation of head velocity.
The literature is consistent that this is worth doing but only over short
horizons: predicting more than a couple of hundred milliseconds overshoots
visibly on direction changes, which reads worse than the lag it removed. Hence
the clamp, and hence the default of 45ms. **Tracking → Latency compensation**
turns it down or off.

## Calibration

The illusion is geometry, not guesswork. Three numbers have to match reality, and the
**Calibration** panel exists to set them:

| Setting | Why it matters |
| --- | --- |
| **Screen diagonal** | Sets the physical size of the projection window. Wrong here and the world shears as you move. |
| **Camera above screen** | Distance from the top edge of the *picture* to the webcam lens. Wrong here and vertical parallax is offset. |
| **Distance scale** | Sets the depth scale for whichever estimator is active. Don't guess it — use the measurement below. |

To measure it: start the camera, sit at a distance you can actually measure with a tape,
type that distance into **Measure at**, and press **Set**. That solves the active
estimator's single unknown scale factor from what the tracker is seeing right now, which
is far more reliable than trying to look up your webcam's field of view.

Check your work with the **Infinite Tunnel** scene. Its frames are concentric with the
window and exactly its size, so when calibration is right they stay nested and square no
matter where your head goes. If the corridor shears or swims, something above is wrong.

Two more things affect accuracy:

- **Fullscreen (F) is better.** Outside fullscreen the app has to guess where the browser
  window sits on your display, from `window.screenX/screenY` and the height of the browser
  chrome. It is usually close. On a multi-monitor setup it can be well off — switch
  **Canvas position** to "Fills screen" and go fullscreen.
- **Your actual eye spacing.** The 63mm default is an adult mean. It only affects the iris
  estimator; if its reported distance is off by a fixed percentage, this is the knob.

## Scenes

**Places** — real captured locations, loaded as 3D Gaussian splats:

| | |
| --- | --- |
| **Valley** | An open landscape with a big depth range. The best parallax of the set. |
| **Snow Street** | A street after snowfall — strong near-to-far structure down the road. |

Plus **Load a capture by URL** in the Library, which takes any `.spz`, `.ply`,
`.splat` or `.ksplat` served with CORS. That box is the real feature; the two
built-ins are a starting point.

**Worlds** — constructed or abstract, filling the aperture directly:

| | |
| --- | --- |
| **Portal Room** | A lit box behind the glass with objects scattered through its depth. |
| **Infinite Tunnel** | Concentric frames rushing past. Doubles as the calibration target. |
| **Top-Down Arena** | A game level as a tilted diorama. **WASD** to drive. |
| **Star Field** | Pure parallax — no occlusion, no shading, no familiar objects. |
| **Sample models** | Procedural objects on a pedestal, for checking the model viewer. |

### Why splats, and not something else

A 360° photo has no parallax at all: every pixel sits at infinity, so leaning
does nothing and the illusion dies on contact. A photogrammetry mesh has real
depth but bakes away the view-dependent shading — reflections, foliage, glass —
that makes a place look like a place. A Gaussian splat keeps both, which is why
it's the representation used here.

It also happens to compose cleanly with head tracking. Spark computes each
splat's screen footprint from `projectionMatrix[0][0]` and `[1][1]`, and the
off-axis shear lives in the matrix's third column, leaving those focal terms
untouched. Splats render correctly through a head-tracked frustum with no
special handling.

Spark is ~5MB, so it is loaded on demand the first time you open a capture.

### Placing a capture

Captures carry no agreed scale, up-axis or origin. One of these measured 916
units across with its origin off to one side, which put the default viewpoint
inside the point cloud. So the app derives a framing from the capture's own
geometry — percentile bounds over a sample of splat centres, a 180° flip
(COLMAP-style pipelines are Y-down, and Spark's own examples correct the same
way), and a scale that maps the horizontal diagonal to about 22 metres.

That gets most captures close. It will not get them all right: these are shells
with a hard front boundary, and the band of good viewpoints can be narrow — on
the Valley, 8.4m frames the whole landscape and 9.4m has you inside the
mountain. **Placement** in the panel is how you fix the rest, and it is the
first thing to reach for after pasting a URL.

Good sources: [SuperSplat gallery](https://superspl.at/), [Polycam](https://poly.cam/explore),
or anything you capture yourself with a phone.

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
    headPose.ts      MediaPipe's metric head pose (dependency-free, unit tested)
    pinhole.ts       iris pair -> eye position (dependency-free, unit tested)
    predict.ts       velocity extrapolation for latency (unit tested)
    headTracker.ts   webcam + MediaPipe, driven by requestVideoFrameCallback
    oneEuro.ts       1€ filter
    screen.ts        physical display geometry, in metres
    viewer.ts        renderer, scene lifecycle, off-axis camera
    splatRuntime.ts  lazy loader for the Gaussian splat renderer
    modelLoader.ts   multi-file mesh loading
    settings.ts      persisted state
  scenes/
    splatPlace.ts    captured places, with auto-framing
    places.ts        the curated capture list
    reveal.ts        the window's wall thickness — the near-parallax anchor
    portalRoom.ts tunnel.ts arena.ts starfield.ts   constructed worlds
    showcase.ts      pedestal scene for uploads and sample models
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

## Deploying

Hosted on Vercel. `vercel.json` sets the framework, the build command and explicit
`application/wasm` headers for the MediaPipe runtime; `engines.node` pins Node 24 so the
build can run the TypeScript tests with native type stripping.

```
vercel --prod
```

`npm run build` — and therefore every deploy — runs typecheck and tests first, so a broken
projection can't ship.

## Requirements

A browser with WebGL2 and `getUserMedia`, which means a secure context: `https://` or
`localhost`. To test from a phone on your LAN you'll need a tunnel or a local TLS cert;
plain `http://192.168.x.x` will not get you a camera.

## Credits

- Kooima, R. — *Generalized Perspective Projection* (2008)
- Casiez, Roussel & Vogel — *1€ Filter* (CHI 2012)
- [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)
- [three.js](https://threejs.org)
- [Spark](https://sparkjs.dev) (World Labs) — the Gaussian splat renderer, MIT.
  The built-in captures are its public demo assets, linked and credited in the
  panel, never redistributed.

Johnny Lee's 2007 Wii-remote head tracking demo is the ancestor of all of this.

## License

MIT
