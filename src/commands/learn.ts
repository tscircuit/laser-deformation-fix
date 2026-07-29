import { readFile, writeFile } from "node:fs/promises"
import { CalibrationError, OutputConflictError } from "../errors.js"
import { buildCorrespondences } from "../calibration/correspondences.js"
import { fitBicubic } from "../calibration/fit-bicubic.js"
import {
  extractToolingLayer,
  normalizeToolingPath,
} from "../calibration/tooling.js"
import { stringifyGlobalWarpTransform } from "../calibration/transform.js"
import type { GlobalWarpTransform, ToolingPathTransform } from "../types.js"
import { parseLightBurn } from "../xml/parse-lightburn.js"
import { verifyTransformAgainstReference } from "./verify.js"

const MAX_DIRECT_FIT_ERROR_MM = 0.0001

export interface LearnOptions {
  tolerance?: number
}

export interface LearnResult {
  transform: GlobalWarpTransform
  matchedShapeCount: number
  warnings: string[]
}

async function writeTransform(
  outputPath: string,
  transform: GlobalWarpTransform,
): Promise<void> {
  try {
    await writeFile(outputPath, stringifyGlobalWarpTransform(transform), {
      encoding: "utf8",
      flag: "wx",
    })
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new OutputConflictError(`Transformation output already exists: ${outputPath}`)
    }
    throw error
  }
}

export async function learnCommand(
  originalPath: string,
  correctedPath: string,
  outputPath: string,
  options: LearnOptions = {},
): Promise<LearnResult> {
  const [originalXml, correctedXml] = await Promise.all([
    readFile(originalPath, "utf8"),
    readFile(correctedPath, "utf8"),
  ])
  const original = parseLightBurn(originalXml, originalPath)
  const corrected = parseLightBurn(correctedXml, correctedPath)
  const sourceTooling = extractToolingLayer(original, "calibration")
  const targetTooling = extractToolingLayer(corrected, "calibration")
  if (sourceTooling.cutIndex !== targetTooling.cutIndex) {
    throw new CalibrationError(
      `Tool CutIndex differs between calibration files: `
      + `${sourceTooling.cutIndex} vs ${targetTooling.cutIndex}`,
    )
  }
  const result = buildCorrespondences(original, corrected)
  const fittedCorrespondences = result.correspondences
  const fit = fitBicubic(fittedCorrespondences, sourceTooling.bounds)
  if (fit.maxErrorMm > MAX_DIRECT_FIT_ERROR_MM) {
    throw new CalibrationError(
      `Direct bicubic fit maximum residual ${fit.maxErrorMm.toFixed(8)} mm exceeds `
      + `${MAX_DIRECT_FIT_ERROR_MM.toFixed(8)} mm`,
    )
  }
  const fittedPathKeys = new Set(fittedCorrespondences.map(
    (item) => `${item.cutIndex}\0${item.layerPathIndex}`,
  ))
  const toolingPaths = sourceTooling.paths.map((sourcePath, index): ToolingPathTransform => ({
    sourceNormalized: normalizeToolingPath(sourcePath.worldPath, sourceTooling.bounds),
    targetWorld: targetTooling.paths[index]!.worldPath,
  })) as GlobalWarpTransform["tooling"]["paths"]
  const transform: GlobalWarpTransform = {
    format: "lightburn-global-warp-v2",
    sourceBoundsMm: sourceTooling.bounds,
    coordinateFrame: { mirrorX: original.mirrorX, mirrorY: original.mirrorY },
    tooling: {
      cutIndex: sourceTooling.cutIndex,
      paths: toolingPaths,
    },
    xCoefficients: fit.xCoefficients,
    yCoefficients: fit.yCoefficients,
    fit: {
      matchedPathCount: fittedPathKeys.size,
      matchedPointCount: fittedCorrespondences.length,
      excludedPathCount: result.excludedPathCount,
      matrixRank: fit.matrixRank,
      rmsErrorMm: fit.rmsErrorMm,
      meanErrorMm: fit.meanErrorMm,
      maxErrorMm: fit.maxErrorMm,
    },
    verification: {
      matchedPathCount: 0,
      maxSymmetricHausdorffMm: 0,
      toleranceMm: options.tolerance ?? 0.01,
    },
  }
  transform.verification = verifyTransformAgainstReference(
    transform,
    original,
    corrected,
    { tolerance: options.tolerance ?? 0.01 },
  )
  await writeTransform(outputPath, transform)
  const warnings = [...result.warnings]
  if (result.excludedPathCount > 0) {
    warnings.push(
      `Excluded ${result.excludedPathCount} path(s) with incompatible raw vertex counts `
      + "from direct fitting; excluded paths remained in contour verification",
    )
  }
  return {
    transform,
    matchedShapeCount: result.matchedShapeCount,
    warnings,
  }
}
