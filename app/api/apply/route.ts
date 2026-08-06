import { applyTransformToDocument } from "@/src/commands/apply"
import { parseGlobalWarpTransform } from "@/src/calibration/transform"
import { LightBurnLensWarpError, TransformValidationError } from "@/src/errors"
import { parseLightBurn } from "@/src/xml/parse-lightburn"
import { serializeLightBurn } from "@/src/xml/serialize-lightburn"
import defaultTransform from "@/generated/alignment_transform.json"

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

function uploadedFile(form: FormData, name: string): File {
  const value = form.get(name)
  if (!(value instanceof File) || value.size === 0) throw new LightBurnLensWarpError(`Missing ${name} file`, "UPLOAD")
  if (value.size > MAX_UPLOAD_BYTES) throw new LightBurnLensWarpError(`${name} exceeds the 50 MB upload limit`, "UPLOAD")
  return value
}

function outputName(inputName: string): string {
  const extension = inputName.toLowerCase().endsWith(".lbrn2") ? ".lbrn2" : ".lbrn"
  const base = inputName.slice(0, -extension.length).replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "") || "lightburn_project"
  return `${base}_transformed${extension}`
}

export async function POST(request: Request) {
  try {
    const form = await request.formData()
    const inputFile = uploadedFile(form, "input")
    if (!/\.lbrn2?$/i.test(inputFile.name)) throw new TransformValidationError("Input project must use .lbrn or .lbrn2")
    let rawTransform: unknown
    const transformSource = form.get("transformSource")
    if (transformSource === "default") {
      rawTransform = defaultTransform
    } else if (transformSource === "generated" || transformSource === "uploaded" || transformSource === null) {
      const transformFile = uploadedFile(form, "transform")
      if (!/\.json$/i.test(transformFile.name)) throw new TransformValidationError("Transformation must use .json")
      try {
        rawTransform = JSON.parse(await transformFile.text()) as unknown
      } catch (error) {
        throw new TransformValidationError(`Invalid transformation JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      throw new TransformValidationError("Unknown transformation matrix source")
    }
    const transform = parseGlobalWarpTransform(rawTransform)
    const document = parseLightBurn(await inputFile.text(), inputFile.name)
    const result = applyTransformToDocument(document, transform)
    const xml = serializeLightBurn(result.document)
    parseLightBurn(xml, inputFile.name)
    const name = outputName(inputFile.name)
    return new Response(xml, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Content-Type": "application/xml; charset=utf-8",
        "X-Corrected-Shapes": String(result.correctedShapeCount),
        "X-Outside-Points": String(result.outsidePointCount),
        "X-Output-File": name,
      },
    })
  } catch (error) {
    const known = error instanceof LightBurnLensWarpError
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: known ? 400 : 500, headers: { "Cache-Control": "no-store" } },
    )
  }
}
