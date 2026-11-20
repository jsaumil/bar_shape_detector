// OCR of single-line images with the `tesseract` program (same engine as the Python scripts)
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

export const OCR_WORKERS = 4

// Reads a whole list of images in one tesseract run
async function ocrChunk(images: Buffer[], whitelist: string): Promise<string[]> {
  const dir = await mkdtemp(path.join(tmpdir(), "ocr-"))
  try {
    const names = await Promise.all(images.map(async (img, i) => {
      const name = path.join(dir, `${i}.png`)
      await Bun.write(name, img)
      return name
    }))
    const listing = path.join(dir, "list.txt")
    await Bun.write(listing, names.join("\n") + "\n")
    const proc = Bun.spawn(
      ["tesseract", listing, "stdout", "--psm", "7", "-c", `tessedit_char_whitelist=${whitelist}`],
      { stdout: "pipe", stderr: "ignore", env: { ...process.env, OMP_THREAD_LIMIT: "1" } },
    )
    const out = await new Response(proc.stdout).text()
    await proc.exited
    const texts = out.split("\f").map((t) => t.trim()).slice(0, images.length)
    return [...texts, ...Array<string>(images.length - texts.length).fill("")]
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// OCR many images, a few tesseract processes at once (too many can exhaust memory)
export async function ocrImages(images: Buffer[], whitelist: string): Promise<string[]> {
  if (!images.length) return []
  const size = Math.ceil(images.length / OCR_WORKERS)
  const chunks: Buffer[][] = []
  for (let i = 0; i < images.length; i += size) chunks.push(images.slice(i, i + size))
  const results = await Promise.all(chunks.map((chunk) => ocrChunk(chunk, whitelist)))
  return results.flat()
}
