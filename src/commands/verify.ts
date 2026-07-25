import { readFile } from "node:fs/promises"
import { TopologyMismatchError, VerificationError } from "../errors.js"
import { shapeToWorldGeometry } from "../geometry/shape-conversion.js"
import type {
  LayerWarpTransform,
  LightBurnDocument,
  Point,
  WorldContour,
} from "../types.js"
import { collectShapeRecords, GeometryResolver } from "../xml/geometry-resolver.js"
import { parseLightBurn } from "../xml/parse-lightburn.js"
import { parseLayerWarpTransform } from "../calibration/transform.js"
import { applyTransformToDocument } from "./apply.js"

export interface VerifyOptions {
  tolerance?: number
  cutIndexes?: readonly string[]
}

export interface VerifyResult {
  matchedPathCount: number
  maxSymmetricHausdorffMm: number
  toleranceMm: number
}

interface ComparablePath {
  cutIndex: string
  layerPathIndex: number
  contours: WorldContour[]
}

interface Segment {
  start: Point
  end: Point
}

function comparablePaths(
  document: LightBurnDocument,
  maxSegmentLength: number,
  includedCutIndexes?: ReadonlySet<string>,
): Map<string, ComparablePath[]> {
  const shapes = collectShapeRecords(document.root)
  const resolver = new GeometryResolver(shapes)
  const result = new Map<string, ComparablePath[]>()
  for (const shape of shapes) {
    if (shape.shapeType !== "Path") continue
    const cutIndex = shape.element.attributes.CutIndex ?? ""
    if (includedCutIndexes && !includedCutIndexes.has(cutIndex)) continue
    const geometry = shapeToWorldGeometry(
      shape,
      resolver,
      {
        maxSegmentLength,
        flatnessTolerance: Math.min(0.001, maxSegmentLength / 5),
      },
      { warnings: [], warn: () => undefined },
    )
    if (!geometry) continue
    const layer = result.get(cutIndex) ?? []
    layer.push({ cutIndex, layerPathIndex: layer.length, contours: geometry.contours })
    result.set(cutIndex, layer)
  }
  return result
}

function contourSegments(contour: WorldContour): Segment[] {
  const segments: Segment[] = []
  for (let index = 1; index < contour.points.length; index++) {
    segments.push({ start: contour.points[index - 1]!, end: contour.points[index]! })
  }
  if (contour.closed && contour.points.length > 1) {
    segments.push({ start: contour.points.at(-1)!, end: contour.points[0]! })
  }
  return segments
}

function pointSegmentDistance(point: Point, segment: Segment): number {
  const dx = segment.end.x - segment.start.x
  const dy = segment.end.y - segment.start.y
  const lengthSquared = dx ** 2 + dy ** 2
  if (lengthSquared <= 1e-24) {
    return Math.hypot(point.x - segment.start.x, point.y - segment.start.y)
  }
  const t = Math.max(0, Math.min(1, (
    (point.x - segment.start.x) * dx + (point.y - segment.start.y) * dy
  ) / lengthSquared))
  return Math.hypot(
    point.x - (segment.start.x + t * dx),
    point.y - (segment.start.y + t * dy),
  )
}

function directedPolylineDistance(
  source: WorldContour,
  target: WorldContour,
  failureLimit: number,
): number {
  const segments = contourSegments(target)
  const cellSize = failureLimit
  const grid = new Map<string, Segment[]>()
  for (const segment of segments) {
    const minCellX = Math.floor((Math.min(segment.start.x, segment.end.x) - failureLimit) / cellSize)
    const maxCellX = Math.floor((Math.max(segment.start.x, segment.end.x) + failureLimit) / cellSize)
    const minCellY = Math.floor((Math.min(segment.start.y, segment.end.y) - failureLimit) / cellSize)
    const maxCellY = Math.floor((Math.max(segment.start.y, segment.end.y) + failureLimit) / cellSize)
    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
        const key = `${cellX},${cellY}`
        const cell = grid.get(key) ?? []
        cell.push(segment)
        grid.set(key, cell)
      }
    }
  }
  let maximum = 0
  for (const point of source.points) {
    let minimum = Number.POSITIVE_INFINITY
    const candidates = grid.get(
      `${Math.floor(point.x / cellSize)},${Math.floor(point.y / cellSize)}`,
    ) ?? []
    for (const segment of candidates) {
      minimum = Math.min(minimum, pointSegmentDistance(point, segment))
    }
    if (!Number.isFinite(minimum)) return failureLimit
    maximum = Math.max(maximum, minimum)
    if (maximum > failureLimit) return maximum
  }
  return maximum
}

function symmetricHausdorff(
  left: WorldContour,
  right: WorldContour,
  failureLimit: number,
): number {
  return Math.max(
    directedPolylineDistance(left, right, failureLimit),
    directedPolylineDistance(right, left, failureLimit),
  )
}

export function comparePathGeometry(
  actual: LightBurnDocument,
  reference: LightBurnDocument,
  options: VerifyOptions = {},
): VerifyResult {
  const tolerance = options.tolerance ?? 0.01
  if (!(tolerance > 0) || !Number.isFinite(tolerance)) {
    throw new VerificationError("--tolerance must be a positive finite number")
  }
  const sampleLength = Math.min(0.01, tolerance / 2)
  const includedCutIndexes = options.cutIndexes
    ? new Set(options.cutIndexes)
    : undefined
  const actualLayers = comparablePaths(actual, sampleLength, includedCutIndexes)
  const referenceLayers = comparablePaths(reference, sampleLength, includedCutIndexes)
  const cutIndexes = [...new Set([...actualLayers.keys(), ...referenceLayers.keys()])]
  let matchedPathCount = 0
  let maximum = 0
  for (const cutIndex of cutIndexes) {
    const actualPaths = actualLayers.get(cutIndex) ?? []
    const referencePaths = referenceLayers.get(cutIndex) ?? []
    if (actualPaths.length !== referencePaths.length) {
      throw new VerificationError(
        `Different path counts on CutIndex ${cutIndex || "(missing)"}: `
        + `${actualPaths.length} vs ${referencePaths.length}`,
      )
    }
    for (let pathIndex = 0; pathIndex < actualPaths.length; pathIndex++) {
      const actualPath = actualPaths[pathIndex]!
      const referencePath = referencePaths[pathIndex]!
      if (actualPath.contours.length !== referencePath.contours.length) {
        throw new TopologyMismatchError(
          `CutIndex ${cutIndex || "(missing)"} path ${pathIndex} has different contour counts`,
        )
      }
      for (let contourIndex = 0; contourIndex < actualPath.contours.length; contourIndex++) {
        const actualContour = actualPath.contours[contourIndex]!
        const referenceContour = referencePath.contours[contourIndex]!
        if (actualContour.closed !== referenceContour.closed) {
          throw new TopologyMismatchError(
            `CutIndex ${cutIndex || "(missing)"} path ${pathIndex} contour ${contourIndex} `
            + "differs in open/closed topology",
          )
        }
        maximum = Math.max(
          maximum,
          symmetricHausdorff(actualContour, referenceContour, tolerance * 1.5),
        )
      }
      matchedPathCount++
    }
  }
  if (maximum > tolerance) {
    throw new VerificationError(
      `Maximum symmetric Hausdorff distance ${maximum.toFixed(8)} mm exceeds `
      + `${tolerance.toFixed(8)} mm tolerance`,
    )
  }
  return {
    matchedPathCount,
    maxSymmetricHausdorffMm: maximum,
    toleranceMm: tolerance,
  }
}

export function verifyTransformAgainstReference(
  transform: LayerWarpTransform,
  input: LightBurnDocument,
  reference: LightBurnDocument,
  options: VerifyOptions = {},
): VerifyResult {
  const generated = applyTransformToDocument(input, transform, {
    segmentLength: 0.05,
    allowOutside: false,
  }).document
  const nonlinearCutIndexes = new Set(
    transform.rules.flatMap((rule) => rule.cutIndexes),
  )
  const nonlinearResult = comparePathGeometry(generated, reference, {
    ...options,
    cutIndexes: [...nonlinearCutIndexes],
  })
  const translationPathCount = collectShapeRecords(input.root).filter((shape) => (
    shape.shapeType === "Path"
    && !nonlinearCutIndexes.has(shape.element.attributes.CutIndex ?? "")
  )).length
  return {
    ...nonlinearResult,
    matchedPathCount: nonlinearResult.matchedPathCount + translationPathCount,
  }
}

export async function verifyCommand(
  transformPath: string,
  inputPath: string,
  referencePath: string,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  let rawTransform: unknown
  try {
    rawTransform = JSON.parse(await readFile(transformPath, "utf8")) as unknown
  } catch (error) {
    throw new VerificationError(
      `Invalid transformation JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const transform = parseLayerWarpTransform(rawTransform)
  const [input, reference] = await Promise.all([
    readFile(inputPath, "utf8").then((xml) => parseLightBurn(xml, inputPath)),
    readFile(referencePath, "utf8").then((xml) => parseLightBurn(xml, referencePath)),
  ])
  return verifyTransformAgainstReference(transform, input, reference, options)
}
