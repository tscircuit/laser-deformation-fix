import { transformPoint } from "./affine.js"
import { appendWithoutDuplicate, flattenCubicBezier, subdivideLine } from "./subdivision.js"
import type { AffineMatrix, Point, ResolvedPath, WorldContour } from "../types.js"

export interface FlattenOptions {
  maxSegmentLength: number
  flatnessTolerance: number
}

function samePoint(a: Point, b: Point): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= 1e-8
}

export function pathToWorldContours(
  path: ResolvedPath,
  worldTransform: AffineMatrix,
  options: FlattenOptions,
): WorldContour[] {
  const contours: WorldContour[] = []
  let points: Point[] = []
  let expectedStart: number | undefined
  let contourStart: number | undefined

  const finish = (): void => {
    if (points.length < 2) return
    const closed = samePoint(points[0]!, points.at(-1)!) || expectedStart === contourStart
    if (closed && samePoint(points[0]!, points.at(-1)!)) points.pop()
    contours.push({ points, closed })
    points = []
    expectedStart = undefined
    contourStart = undefined
  }

  for (const primitive of path.primitives) {
    if (expectedStart !== undefined && primitive.startIndex !== expectedStart) finish()
    if (contourStart === undefined) contourStart = primitive.startIndex
    const startVertex = path.vertices[primitive.startIndex]!
    const endVertex = path.vertices[primitive.endIndex]!
    const start = transformPoint(worldTransform, startVertex)
    const end = transformPoint(worldTransform, endVertex)
    const segment = primitive.kind === "line"
      ? subdivideLine(start, end, options.maxSegmentLength)
      : flattenCubicBezier(
          start,
          transformPoint(worldTransform, startVertex.c0!),
          transformPoint(worldTransform, endVertex.c1!),
          end,
          options,
        )
    appendWithoutDuplicate(points, segment)
    expectedStart = primitive.endIndex
  }
  finish()
  return contours
}

export function contourBounds(contours: readonly WorldContour[]): [number, number, number, number] {
  const points = contours.flatMap((contour) => contour.points)
  if (points.length === 0) throw new Error("Cannot compute bounds of empty geometry")
  return [
    Math.min(...points.map((point) => point.x)),
    Math.min(...points.map((point) => point.y)),
    Math.max(...points.map((point) => point.x)),
    Math.max(...points.map((point) => point.y)),
  ]
}

export function boundsCenter(bounds: [number, number, number, number]): Point {
  return { x: (bounds[0] + bounds[2]) / 2, y: (bounds[1] + bounds[3]) / 2 }
}

export function contourPerimeter(contours: readonly WorldContour[]): number {
  let length = 0
  for (const contour of contours) {
    for (let index = 1; index < contour.points.length; index++) {
      length += Math.hypot(
        contour.points[index]!.x - contour.points[index - 1]!.x,
        contour.points[index]!.y - contour.points[index - 1]!.y,
      )
    }
    if (contour.closed && contour.points.length > 1) {
      length += Math.hypot(
        contour.points[0]!.x - contour.points.at(-1)!.x,
        contour.points[0]!.y - contour.points.at(-1)!.y,
      )
    }
  }
  return length
}

export function resampleContour(contour: WorldContour, count: number): Point[] {
  if (count < 2) throw new RangeError("Contour sample count must be at least two")
  const points = contour.closed ? [...contour.points, contour.points[0]!] : contour.points
  const cumulative = [0]
  for (let index = 1; index < points.length; index++) {
    cumulative.push(cumulative.at(-1)! + Math.hypot(
      points[index]!.x - points[index - 1]!.x,
      points[index]!.y - points[index - 1]!.y,
    ))
  }
  const total = cumulative.at(-1)!
  if (total <= 1e-12) return Array.from({ length: count }, () => ({ ...points[0]! }))
  const divisor = contour.closed ? count : count - 1
  return Array.from({ length: count }, (_, sampleIndex) => {
    const target = total * sampleIndex / divisor
    let segment = 1
    while (segment < cumulative.length && cumulative[segment]! < target) segment++
    segment = Math.min(segment, cumulative.length - 1)
    const startDistance = cumulative[segment - 1]!
    const endDistance = cumulative[segment]!
    const t = endDistance === startDistance ? 0 : (target - startDistance) / (endDistance - startDistance)
    const start = points[segment - 1]!
    const end = points[segment]!
    return { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t }
  })
}
