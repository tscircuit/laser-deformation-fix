import { CalibrationError, TransformValidationError } from "../errors.js"
import { transformPoint } from "../geometry/affine.js"
import type {
  LightBurnDocument,
  Point,
  ResolvedPath,
  ShapeRecord,
  ToolingPathTransform,
  Vertex,
} from "../types.js"
import { collectShapeRecords, GeometryResolver } from "../xml/geometry-resolver.js"
import { findElements, firstChild } from "../xml/node-utils.js"
import { validateBounds } from "./transform.js"

const TOOLING_PATH_COUNT = 4
export const TOOLING_MATCH_TOLERANCE = 1e-6

export interface ToolingPath {
  shape: ShapeRecord
  worldPath: ResolvedPath
}

export interface ToolingLayer {
  cutIndex: string
  paths: [ToolingPath, ToolingPath, ToolingPath, ToolingPath]
  bounds: [number, number, number, number]
}

type ToolingErrorKind = "calibration" | "transform"

function toolingError(kind: ToolingErrorKind, message: string): Error {
  return kind === "calibration"
    ? new CalibrationError(message)
    : new TransformValidationError(message)
}

function worldVertex(shape: ShapeRecord, vertex: Vertex): Vertex {
  return {
    ...transformPoint(shape.worldTransform, vertex),
    ...(vertex.c0 ? { c0: transformPoint(shape.worldTransform, vertex.c0) } : {}),
    ...(vertex.c1 ? { c1: transformPoint(shape.worldTransform, vertex.c1) } : {}),
  }
}

function worldPath(shape: ShapeRecord, path: ResolvedPath): ResolvedPath {
  return {
    vertices: path.vertices.map((vertex) => worldVertex(shape, vertex)),
    primitives: path.primitives.map((primitive) => ({ ...primitive })),
    closed: path.closed,
  }
}

function pathBounds(paths: readonly ToolingPath[]): [number, number, number, number] {
  const points = paths.flatMap(({ worldPath: path }) => path.vertices)
  const bounds: [number, number, number, number] = [
    Math.min(...points.map((point) => point.x)),
    Math.min(...points.map((point) => point.y)),
    Math.max(...points.map((point) => point.x)),
    Math.max(...points.map((point) => point.y)),
  ]
  validateBounds(bounds)
  return bounds
}

export function extractToolingLayer(
  document: LightBurnDocument,
  kind: ToolingErrorKind,
): ToolingLayer {
  const tooling = extractOptionalToolingLayer(document, kind)
  if (!tooling) {
    throw toolingError(kind, "Expected exactly one Tool CutSetting, found 0")
  }
  return tooling
}

export function extractOptionalToolingLayer(
  document: LightBurnDocument,
  kind: ToolingErrorKind,
): ToolingLayer | undefined {
  const settings = findElements(document.root, "CutSetting")
    .filter((setting) => setting.attributes.type === "Tool")
  if (settings.length === 0) return undefined
  if (settings.length !== 1) {
    throw toolingError(
      kind,
      `Expected exactly one Tool CutSetting, found ${settings.length}`,
    )
  }
  const cutIndex = firstChild(settings[0]!, "index")?.attributes.Value
  if (!cutIndex) {
    throw toolingError(kind, "Tool CutSetting is missing its index Value")
  }
  const shapes = collectShapeRecords(document.root)
    .filter((shape) => shape.element.attributes.CutIndex === cutIndex)
  if (shapes.length !== TOOLING_PATH_COUNT || shapes.some((shape) => shape.shapeType !== "Path")) {
    throw toolingError(
      kind,
      `Tool CutIndex ${cutIndex} must contain exactly four Path shapes; found `
      + `${shapes.length} shape(s)`,
    )
  }
  const resolver = new GeometryResolver(collectShapeRecords(document.root))
  const paths = shapes.map((shape): ToolingPath => ({
    shape,
    worldPath: worldPath(shape, resolver.resolve(shape)),
  })) as [ToolingPath, ToolingPath, ToolingPath, ToolingPath]
  return { cutIndex, paths, bounds: pathBounds(paths) }
}

function normalizePoint(
  point: Point,
  bounds: [number, number, number, number],
): Point {
  return {
    x: (point.x - bounds[0]) / (bounds[2] - bounds[0]),
    y: (point.y - bounds[1]) / (bounds[3] - bounds[1]),
  }
}

export function normalizeToolingPath(
  path: ResolvedPath,
  bounds: [number, number, number, number],
): ResolvedPath {
  return {
    vertices: path.vertices.map((vertex) => ({
      ...normalizePoint(vertex, bounds),
      ...(vertex.c0 ? { c0: normalizePoint(vertex.c0, bounds) } : {}),
      ...(vertex.c1 ? { c1: normalizePoint(vertex.c1, bounds) } : {}),
    })),
    primitives: path.primitives.map((primitive) => ({ ...primitive })),
    closed: path.closed,
  }
}

function topologyMatches(left: ResolvedPath, right: ResolvedPath): boolean {
  return left.closed === right.closed
    && left.vertices.length === right.vertices.length
    && left.primitives.length === right.primitives.length
    && left.primitives.every((primitive, index) => (
      primitive.kind === right.primitives[index]?.kind
    ))
}

function pathPoints(path: ResolvedPath): Point[] {
  return path.vertices.flatMap((vertex) => [
    { x: vertex.x, y: vertex.y },
    ...(vertex.c0 ? [vertex.c0] : []),
    ...(vertex.c1 ? [vertex.c1] : []),
  ])
}

function directedPointSetDistance(source: readonly Point[], target: readonly Point[]): number {
  return Math.max(...source.map((point) => Math.min(...target.map((candidate) => (
    Math.hypot(point.x - candidate.x, point.y - candidate.y)
  )))))
}

function pathDistance(left: ResolvedPath, right: ResolvedPath): number {
  if (!topologyMatches(left, right)) return Number.POSITIVE_INFINITY
  const leftPoints = pathPoints(left)
  const rightPoints = pathPoints(right)
  return Math.max(
    directedPointSetDistance(leftPoints, rightPoints),
    directedPointSetDistance(rightPoints, leftPoints),
  )
}

function permutations(values: readonly number[]): number[][] {
  if (values.length === 0) return [[]]
  return values.flatMap((value, index) => permutations([
    ...values.slice(0, index),
    ...values.slice(index + 1),
  ]).map((rest) => [value, ...rest]))
}

export function matchToolingPaths(
  input: readonly ResolvedPath[],
  templates: readonly ToolingPathTransform[],
): number[] {
  if (input.length !== TOOLING_PATH_COUNT || templates.length !== TOOLING_PATH_COUNT) {
    throw new TransformValidationError("Tooling matching requires exactly four input and template paths")
  }
  let best: { assignment: number[]; maximum: number; total: number } | undefined
  for (const assignment of permutations([0, 1, 2, 3])) {
    const distances = input.map((path, index) => (
      pathDistance(path, templates[assignment[index]!]!.sourceNormalized)
    ))
    const candidate = {
      assignment,
      maximum: Math.max(...distances),
      total: distances.reduce((sum, distance) => sum + distance, 0),
    }
    if (
      !best
      || candidate.maximum < best.maximum
      || (candidate.maximum === best.maximum && candidate.total < best.total)
    ) {
      best = candidate
    }
  }
  if (!best || !Number.isFinite(best.maximum) || best.maximum > TOOLING_MATCH_TOLERANCE) {
    const distance = best?.maximum
    const detail = Number.isFinite(distance)
      ? `best normalized geometry error was ${distance!.toExponential(3)}`
      : "no topology-compatible assignment exists"
    throw new TransformValidationError(
      `Input Tool layer does not match the calibration tooling template: ${detail}`,
    )
  }
  return best.assignment
}
