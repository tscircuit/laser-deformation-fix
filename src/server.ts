import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { basename, extname, join } from "node:path"
import { tmpdir } from "node:os"
import { applyCommand } from "./commands/apply.js"
import { learnCommand } from "./commands/learn.js"
import { LightBurnLensWarpError } from "./errors.js"

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const UI_DIRECTORY = join(import.meta.dir, "..", "ui")

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  })
}

function uploadedFile(form: FormData, name: string): File {
  const value = form.get(name)
  if (!(value instanceof File) || value.size === 0) {
    throw new LightBurnLensWarpError(`Missing ${name} file`, "UPLOAD")
  }
  if (value.size > MAX_UPLOAD_BYTES) {
    throw new LightBurnLensWarpError(
      `${name} exceeds the 50 MB upload limit`,
      "UPLOAD",
    )
  }
  return value
}

function lightBurnExtension(file: File): ".lbrn" | ".lbrn2" {
  const extension = extname(file.name).toLowerCase()
  if (extension !== ".lbrn" && extension !== ".lbrn2") {
    throw new LightBurnLensWarpError(
      `${file.name || "Uploaded project"} must use .lbrn or .lbrn2`,
      "UPLOAD",
    )
  }
  return extension
}

function safeBaseName(file: File): string {
  const base = basename(file.name, extname(file.name))
    .replaceAll(/[^a-zA-Z0-9_-]+/g, "_")
    .replaceAll(/^_+|_+$/g, "")
  return base || "lightburn_project"
}

async function writeUpload(file: File, path: string): Promise<void> {
  await writeFile(path, new Uint8Array(await file.arrayBuffer()))
}

async function handleLearn(request: Request): Promise<Response> {
  const form = await request.formData()
  const original = uploadedFile(form, "original")
  const corrected = uploadedFile(form, "corrected")
  const originalExtension = lightBurnExtension(original)
  const correctedExtension = lightBurnExtension(corrected)
  const directory = await mkdtemp(join(tmpdir(), "lightburn-learn-"))
  try {
    const originalPath = join(directory, `original${originalExtension}`)
    const correctedPath = join(directory, `corrected${correctedExtension}`)
    const transformPath = join(directory, "alignment_transform.json")
    await Promise.all([
      writeUpload(original, originalPath),
      writeUpload(corrected, correctedPath),
    ])
    const result = await learnCommand(originalPath, correctedPath, transformPath)
    return jsonResponse({
      transform: result.transform,
      transformFileName: "alignment_transform.json",
      summary: {
        matchedPaths: result.matchedShapeCount,
        fittedPoints: result.transform.fit.matchedPointCount,
        matrixRank: result.transform.fit.matrixRank,
        rmsErrorMm: result.transform.fit.rmsErrorMm,
        maxErrorMm: result.transform.fit.maxErrorMm,
        verificationErrorMm:
          result.transform.verification.maxSymmetricHausdorffMm,
      },
      warnings: [...new Set(result.warnings)],
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function handleApply(request: Request): Promise<Response> {
  const form = await request.formData()
  const transform = uploadedFile(form, "transform")
  const input = uploadedFile(form, "input")
  if (extname(transform.name).toLowerCase() !== ".json") {
    throw new LightBurnLensWarpError(
      `${transform.name || "Transformation"} must use .json`,
      "UPLOAD",
    )
  }
  const inputExtension = lightBurnExtension(input)
  const directory = await mkdtemp(join(tmpdir(), "lightburn-apply-"))
  try {
    const transformPath = join(directory, "transform.json")
    const inputPath = join(directory, `input${inputExtension}`)
    const outputFileName = `${safeBaseName(input)}_transformed${inputExtension}`
    const outputPath = join(directory, outputFileName)
    await Promise.all([
      writeUpload(transform, transformPath),
      writeUpload(input, inputPath),
    ])
    const result = await applyCommand(transformPath, inputPath, outputPath)
    const output = await readFile(outputPath)
    return new Response(output, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${outputFileName}"`,
        "Content-Type": "application/xml; charset=utf-8",
        "X-Corrected-Shapes": String(result.correctedShapeCount),
        "X-Outside-Points": String(result.outsidePointCount),
        "X-Output-File": outputFileName,
      },
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function staticResponse(pathname: string): Response | undefined {
  const files: Record<string, { path: string; type: string }> = {
    "/": { path: "index.html", type: "text/html; charset=utf-8" },
    "/app.js": { path: "app.js", type: "text/javascript; charset=utf-8" },
    "/styles.css": { path: "styles.css", type: "text/css; charset=utf-8" },
  }
  const asset = files[pathname]
  if (!asset) return undefined
  return new Response(Bun.file(join(UI_DIRECTORY, asset.path)), {
    headers: {
      "Content-Type": asset.type,
      "Cache-Control": "no-cache",
    },
  })
}

export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url)
  try {
    if (request.method === "GET") {
      if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 })
      return staticResponse(url.pathname)
        ?? jsonResponse({ error: "Not found" }, 404)
    }
    if (request.method === "POST" && url.pathname === "/api/learn") {
      return await handleLearn(request)
    }
    if (request.method === "POST" && url.pathname === "/api/apply") {
      return await handleApply(request)
    }
    return jsonResponse({ error: "Not found" }, 404)
  } catch (error) {
    const known = error instanceof LightBurnLensWarpError
    if (!known) console.error(error)
    return jsonResponse({
      error: error instanceof Error ? error.message : String(error),
      ...(known ? { code: error.code } : {}),
    }, known ? 400 : 500)
  }
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`)
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: handleRequest,
  })
  console.log(`LightBurn Warp UI: ${server.url}`)
}
