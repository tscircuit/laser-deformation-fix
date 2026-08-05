import { LightBurnLensWarpError } from "@/src/errors"
import { learnTransformFromXml } from "@/src/commands/learn"

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

function uploadedFile(form: FormData, name: string): File {
  const value = form.get(name)
  if (!(value instanceof File) || value.size === 0) {
    throw new LightBurnLensWarpError(`Missing ${name} file`, "UPLOAD")
  }
  if (value.size > MAX_UPLOAD_BYTES) {
    throw new LightBurnLensWarpError(`${name} exceeds the 50 MB upload limit`, "UPLOAD")
  }
  if (!/\.lbrn2?$/i.test(value.name)) {
    throw new LightBurnLensWarpError(`${value.name || name} must use .lbrn or .lbrn2`, "UPLOAD")
  }
  return value
}

export async function POST(request: Request) {
  try {
    const form = await request.formData()
    const original = uploadedFile(form, "original")
    const corrected = uploadedFile(form, "corrected")
    const result = learnTransformFromXml(
      await original.text(), original.name,
      await corrected.text(), corrected.name,
    )
    return Response.json({
      transform: result.transform,
      transformFileName: "alignment_transform.json",
      summary: {
        matchedPaths: result.matchedShapeCount,
        fittedPoints: result.transform.fit.matchedPointCount,
        matrixRank: result.transform.fit.matrixRank,
        rmsErrorMm: result.transform.fit.rmsErrorMm,
        maxErrorMm: result.transform.fit.maxErrorMm,
        verificationErrorMm: result.transform.verification.maxSymmetricHausdorffMm,
      },
      warnings: [...new Set(result.warnings)],
    })
  } catch (error) {
    const known = error instanceof LightBurnLensWarpError
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: known ? 400 : 500 })
  }
}
