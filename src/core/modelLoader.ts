import {
  Box3,
  BufferGeometry,
  LoadingManager,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  Vector3,
  type WebGLRenderer,
} from 'three'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'

export const SUPPORTED_EXTENSIONS = ['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply'] as const
export const ACCEPT_ATTRIBUTE =
  '.glb,.gltf,.obj,.mtl,.fbx,.stl,.ply,.bin,.png,.jpg,.jpeg,.webp,.ktx2,.tga'

export interface ModelStats {
  meshes: number
  triangles: number
  vertices: number
  materials: number
  sizeBytes: number
}

export interface LoadedModel {
  object: Object3D
  name: string
  stats: ModelStats
  /** Frees the blob URLs backing this model's external resources. */
  release(): void
}

/**
 * Loads a model from a set of files the user dropped or picked.
 *
 * Browsers hand us `File` objects with no directory, but glTF/OBJ reference
 * their buddies by relative path. So we mint a blob URL per file and install a
 * URL modifier on the LoadingManager that rewrites any request to the matching
 * blob — which is what makes a multi-file .gltf + .bin + textures drop work at
 * all.
 */
export async function loadModelFromFiles(
  files: File[],
  renderer?: WebGLRenderer,
): Promise<LoadedModel> {
  if (files.length === 0) throw new Error('No files selected.')

  const entry = pickEntryFile(files)
  if (!entry) {
    throw new Error(
      `No loadable model in that drop. Supported: ${SUPPORTED_EXTENSIONS.map((e) => `.${e}`).join(', ')}`,
    )
  }

  const urls = new Map<string, string>()
  const created: string[] = []
  for (const file of files) {
    const url = URL.createObjectURL(file)
    created.push(url)
    for (const key of keysFor(file)) urls.set(key, url)
  }
  const release = (): void => {
    for (const url of created) URL.revokeObjectURL(url)
    created.length = 0
  }

  const manager = new LoadingManager()
  manager.setURLModifier((url) => {
    if (url.startsWith('blob:') || url.startsWith('data:')) return url
    const direct = urls.get(normalizeKey(url))
    if (direct) return direct
    const base = urls.get(basename(url))
    return base ?? url
  })

  try {
    const extension = extensionOf(entry.name)
    const entryUrl = urls.get(normalizeKey(entry.name)) ?? urls.get(basename(entry.name))!
    const object = await loadByExtension(extension, entryUrl, manager, files, urls, renderer)
    normalizeUp(object, extension)

    return {
      object,
      name: entry.name.replace(/\.[^.]+$/, ''),
      stats: measure(object, files),
      release,
    }
  } catch (err) {
    release()
    throw err instanceof Error ? err : new Error(String(err))
  }
}

async function loadByExtension(
  extension: string,
  url: string,
  manager: LoadingManager,
  files: File[],
  urls: Map<string, string>,
  renderer: WebGLRenderer | undefined,
): Promise<Object3D> {
  switch (extension) {
    case 'glb':
    case 'gltf': {
      const loader = new GLTFLoader(manager)
      loader.setDRACOLoader(dracoLoader())
      loader.setMeshoptDecoder(MeshoptDecoder)
      const ktx2 = ktx2Loader(renderer)
      if (ktx2) loader.setKTX2Loader(ktx2)
      const gltf = await loader.loadAsync(url)
      return gltf.scene ?? gltf.scenes[0]!
    }

    case 'obj': {
      const loader = new OBJLoader(manager)
      // MTL is optional; a bare OBJ still loads with default materials.
      const mtl = files.find((f) => extensionOf(f.name) === 'mtl')
      if (mtl) {
        const mtlUrl = urls.get(normalizeKey(mtl.name)) ?? urls.get(basename(mtl.name))
        if (mtlUrl) {
          const materials = await new MTLLoader(manager).loadAsync(mtlUrl)
          materials.preload()
          loader.setMaterials(materials)
        }
      }
      return loader.loadAsync(url)
    }

    case 'fbx':
      return new FBXLoader(manager).loadAsync(url)

    case 'stl':
      return wrapGeometry(await new STLLoader(manager).loadAsync(url))

    case 'ply': {
      const geometry = await new PLYLoader(manager).loadAsync(url)
      geometry.computeVertexNormals()
      return wrapGeometry(geometry)
    }

    default:
      throw new Error(`Unsupported file type: .${extension}`)
  }
}

function wrapGeometry(geometry: BufferGeometry): Object3D {
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals()
  const hasColors = Boolean(geometry.getAttribute('color'))
  return new Mesh(
    geometry,
    new MeshStandardMaterial({
      color: hasColors ? 0xffffff : 0xc8d2e0,
      vertexColors: hasColors,
      roughness: 0.55,
      metalness: 0.1,
    }),
  )
}

/**
 * STL, OBJ and FBX all come out of CAD and DCC tools with different ideas about
 * which way is up. glTF is the only one that guarantees Y-up, so everything
 * else gets a Z-up correction when its bounding box says it is lying down.
 */
function normalizeUp(object: Object3D, extension: string): void {
  if (extension === 'glb' || extension === 'gltf') return

  const size = new Box3().setFromObject(object).getSize(new Vector3())
  // Z-up content is typically deeper than it is tall. Rotating a genuinely
  // flat-and-wide model would be wrong, so only act when it is clearly the case.
  if (size.z > size.y * 1.35) {
    object.rotation.x = -Math.PI / 2
    object.updateMatrixWorld(true)
  }
}

function measure(object: Object3D, files: File[]): ModelStats {
  let meshes = 0
  let triangles = 0
  let vertices = 0
  const materials = new Set<unknown>()

  object.traverse((child) => {
    const mesh = child as Mesh
    if (!mesh.isMesh) return
    meshes += 1
    const geometry = mesh.geometry
    const position = geometry.getAttribute('position')
    if (position) vertices += position.count
    const index = geometry.getIndex()
    triangles += Math.floor((index ? index.count : (position?.count ?? 0)) / 3)
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (m) materials.add(m)
    }
  })

  return {
    meshes,
    triangles,
    vertices,
    materials: materials.size,
    sizeBytes: files.reduce((sum, f) => sum + f.size, 0),
  }
}

function pickEntryFile(files: File[]): File | undefined {
  const loadable = files.filter((f) =>
    (SUPPORTED_EXTENSIONS as readonly string[]).includes(extensionOf(f.name)),
  )
  // Prefer glTF: if someone drops a folder containing both a .glb and a
  // converted .obj, the glTF is virtually always the better source.
  const priority = ['glb', 'gltf', 'fbx', 'obj', 'ply', 'stl']
  return loadable.sort(
    (a, b) => priority.indexOf(extensionOf(a.name)) - priority.indexOf(extensionOf(b.name)),
  )[0]
}

function keysFor(file: File): string[] {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath
  const keys = [normalizeKey(file.name), basename(file.name)]
  if (relative) keys.push(normalizeKey(relative), basename(relative))
  return keys
}

function normalizeKey(path: string): string {
  return decodeURIComponent(path).replace(/^\.?\//, '').toLowerCase()
}

function basename(path: string): string {
  const clean = decodeURIComponent(path).split(/[?#]/)[0] ?? ''
  return (clean.split('/').pop() ?? clean).toLowerCase()
}

function extensionOf(name: string): string {
  return (name.split('.').pop() ?? '').toLowerCase()
}

// Both loaders resolve their decoder payloads with `new URL(..., import.meta.url)`
// as of three r185, so the bundler emits and fingerprints them for us. Setting
// an explicit decoder path here would only re-introduce a second, unversioned
// copy of the same wasm.
let draco: DRACOLoader | null = null
function dracoLoader(): DRACOLoader {
  draco ??= new DRACOLoader()
  return draco
}

let ktx2: KTX2Loader | null = null
function ktx2Loader(renderer?: WebGLRenderer): KTX2Loader | null {
  if (!renderer) return ktx2
  ktx2 ??= new KTX2Loader().detectSupport(renderer)
  return ktx2
}
