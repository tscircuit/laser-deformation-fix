import { readFile, writeFile } from "node:fs/promises"
import { CalibrationError, OutputConflictError } from "../errors.js"
import {
  buildCorrespondences,
  type MatchedCalibrationPath,
} from "../calibration/correspondences.js"
import { fitBicubic } from "../calibration/fit-bicubic.js"
import { stringifyLayerWarpTransform } from "../calibration/transform.js"
import { contourBounds, pathToWorldContours } from "../geometry/paths.js"
import type {
  CalibrationCorrespondence,
  LayerWarpTransform,
  Point,
} from "../types.js"
import { parseLightBurn } from "../xml/parse-lightburn.js"
import { verifyTransformAgainstReference } from "./verify.js"

const MAX_DIRECT_FIT_ERROR_MM = 0.0001

export interface LearnOptions {
  tolerance?: number
}

export interface LearnResult {
  transform: LayerWarpTransform
  matchedShapeCount: number
  defaultTranslation: Point
  nonlinearCutIndexes: string[]
  warnings: string[]
}

function translationSpread(correspondences: readonly CalibrationCorrespondence[]): number {
  const dx = correspondences.reduce(
    (sum, item) => sum + item.target.x - item.source.x,
    0,
  ) / correspondences.length
  const dy = correspondences.reduce(
    (sum, item) => sum + item.target.y - item.source.y,
    0,
  ) / correspondences.length
  return Math.max(...correspondences.map((item) => Math.hypot(
    item.target.x - item.source.x - dx,
    item.target.y - item.source.y - dy,
  )))
}

function median(values: readonly number[]): number {
  if (values.length === 0) throw new CalibrationError("Cannot infer moved-layer translation")
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!
}

function matchedLayerBounds(
  paths: readonly MatchedCalibrationPath[],
  side: "source" | "target",
): [number, number, number, number] {
  const contours = paths.flatMap((path) => pathToWorldContours(
    side === "source" ? path.sourcePath : path.targetPath,
    side === "source" ? path.sourceShape.worldTransform : path.targetShape.worldTransform,
    { maxSegmentLength: 0.05, flatnessTolerance: 0.001 },
  ))
  return contourBounds(contours)
}

function movedLayerTranslation(
  paths: readonly MatchedCalibrationPath[],
  nonlinearCutIndexes: readonly string[],
): [number, number] {
  const offsets = nonlinearCutIndexes.map((cutIndex) => {
    const layerPaths = paths.filter((path) => path.cutIndex === cutIndex)
    const source = matchedLayerBounds(layerPaths, "source")
    const target = matchedLayerBounds(layerPaths, "target")
    return {
      x: (target[0] + target[2] - source[0] - source[2]) / 2,
      y: (target[1] + target[3] - source[1] - source[3]) / 2,
    }
  })
  return [
    median(offsets.map((offset) => offset.x)),
    median(offsets.map((offset) => offset.y)),
  ]
}

function numericCutIndexOrder(left: string, right: string): number {
  return Number(left) - Number(right) || left.localeCompare(right)
}

async function writeTransform(
  outputPath: string,
  transform: LayerWarpTransform,
): Promise<void> {
  try {
    await writeFile(outputPath, stringifyLayerWarpTransform(transform), {
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
  const result = buildCorrespondences(original, corrected)
  const byCutIndex = new Map<string, CalibrationCorrespondence[]>()
  for (const item of result.correspondences) {
    byCutIndex.set(item.cutIndex, [...(byCutIndex.get(item.cutIndex) ?? []), item])
  }
  const translationCandidates = [...byCutIndex.entries()]
    .filter(([, items]) => translationSpread(items) <= MAX_DIRECT_FIT_ERROR_MM)
  if (translationCandidates.length === 0) {
    throw new CalibrationError("Could not infer a shared default translation layer")
  }
  const nonlinearCutIndexes = [...byCutIndex.entries()]
    .filter(([, items]) => translationSpread(items) > MAX_DIRECT_FIT_ERROR_MM)
    .map(([cutIndex]) => cutIndex)
    .sort(numericCutIndexOrder)
  if (nonlinearCutIndexes.length === 0) {
    throw new CalibrationError("No nonlinear CutIndex layers were found")
  }
  const nonlinearSet = new Set(nonlinearCutIndexes)
  const fittedCorrespondences = result.correspondences.filter(
    (item) => nonlinearSet.has(item.cutIndex),
  )
  const fit = fitBicubic(fittedCorrespondences, result.sourceBoundsMm)
  if (fit.maxErrorMm > MAX_DIRECT_FIT_ERROR_MM) {
    throw new CalibrationError(
      `Direct bicubic fit maximum residual ${fit.maxErrorMm.toFixed(8)} mm exceeds `
      + `${MAX_DIRECT_FIT_ERROR_MM.toFixed(8)} mm`,
    )
  }
  const fittedPathKeys = new Set(fittedCorrespondences.map(
    (item) => `${item.cutIndex}\0${item.layerPathIndex}`,
  ))
  const provisionalTransform: LayerWarpTransform = {
    format: "lightburn-layer-warp-v2",
    sourceBoundsMm: result.sourceBoundsMm,
    coordinateFrame: { mirrorX: original.mirrorX, mirrorY: original.mirrorY },
    defaultRule: { kind: "translation", offsetMm: [0, 0] },
    rules: [{
      kind: "bicubic",
      cutIndexes: nonlinearCutIndexes,
      xCoefficients: fit.xCoefficients,
      yCoefficients: fit.yCoefficients,
    }],
    fit: {
      matchedPathCount: fittedPathKeys.size,
      matchedPointCount: fittedCorrespondences.length,
      excludedPathCount: result.matchedPaths.filter(
        (path) => nonlinearSet.has(path.cutIndex) && !path.compatibleForDirectFit,
      ).length,
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
  const offset = movedLayerTranslation(result.matchedPaths, nonlinearCutIndexes)
  const transform: LayerWarpTransform = {
    ...provisionalTransform,
    defaultRule: { kind: "translation", offsetMm: offset },
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
      + "from direct fitting; excluded nonlinear paths remained in contour verification",
    )
  }
  return {
    transform,
    matchedShapeCount: result.matchedShapeCount,
    defaultTranslation: { x: offset[0], y: offset[1] },
    nonlinearCutIndexes,
    warnings,
  }
}
