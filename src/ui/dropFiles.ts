/**
 * Flattens a drop into a plain list of Files, walking directories where the
 * browser lets us.
 *
 * Dropping a whole glTF folder is the natural gesture — the .gltf, its .bin and
 * a textures/ subdirectory all need to arrive together — so falling back to
 * `dataTransfer.files` alone (which silently yields nothing for directories)
 * would break the most common case.
 */
export async function filesFromDataTransfer(data: DataTransfer | null): Promise<File[]> {
  if (!data) return []

  const items = Array.from(data.items ?? []).filter((item) => item.kind === 'file')
  const entries = items
    .map((item) => (item.webkitGetAsEntry?.() ?? null) as FileSystemEntry | null)
    .filter((entry): entry is FileSystemEntry => entry !== null)

  if (entries.length === 0) return Array.from(data.files ?? [])

  const files: File[] = []
  await Promise.all(entries.map((entry) => collect(entry, files)))
  return files.length ? files : Array.from(data.files ?? [])
}

const MAX_FILES = 400

async function collect(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (out.length >= MAX_FILES) return

  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => {
      ;(entry as FileSystemFileEntry).file(resolve, () => resolve(null))
    })
    if (file) out.push(file)
    return
  }

  if (!entry.isDirectory) return
  const reader = (entry as FileSystemDirectoryEntry).createReader()

  // readEntries yields at most ~100 per call, so keep reading until it dries up.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) => {
      reader.readEntries(resolve, () => resolve([]))
    })
    if (batch.length === 0) break
    for (const child of batch) await collect(child, out)
    if (out.length >= MAX_FILES) break
  }
}
