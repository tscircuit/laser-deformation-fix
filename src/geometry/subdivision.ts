import type { Point } from "../types.js"

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function pointLineDistance(point: Point, start: Point, end: Point): number {
  const length = distance(start, end)
  if (length < 1e-15) return distance(point, start)
  return Math.abs(
    (end.y - start.y) * point.x - (end.x - start.x) * point.y
      + end.x * start.y - end.y * start.x,
  ) / length
}

export function subdivideLine(start: Point, end: Point, maxSegmentLength: number): Point[] {
  if (!(maxSegmentLength > 0) || !Number.isFinite(maxSegmentLength)) {
    throw new RangeError("maxSegmentLength must be a positive finite number")
  }
  const segments = Math.max(1, Math.ceil(distance(start, end) / maxSegmentLength))
  return Array.from({ length: segments + 1 }, (_, index) => {
    const t = index / segments
    return { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t }
  })
}

export function flattenCubicBezier(
  start: Point,
  control1: Point,
  control2: Point,
  end: Point,
  options: { maxSegmentLength: number; flatnessTolerance: number },
): Point[] {
  if (!(options.maxSegmentLength > 0) || !(options.flatnessTolerance > 0)) {
    throw new RangeError("Bézier subdivision tolerances must be positive")
  }
  const points: Point[] = [{ ...start }]
  const recurse = (p0: Point, p1: Point, p2: Point, p3: Point, depth: number): void => {
    const flatness = Math.max(pointLineDistance(p1, p0, p3), pointLineDistance(p2, p0, p3))
    if ((flatness <= options.flatnessTolerance && distance(p0, p3) <= options.maxSegmentLength) || depth >= 24) {
      points.push({ ...p3 })
      return
    }
    const p01 = midpoint(p0, p1)
    const p12 = midpoint(p1, p2)
    const p23 = midpoint(p2, p3)
    const p012 = midpoint(p01, p12)
    const p123 = midpoint(p12, p23)
    const p0123 = midpoint(p012, p123)
    recurse(p0, p01, p012, p0123, depth + 1)
    recurse(p0123, p123, p23, p3, depth + 1)
  }
  recurse(start, control1, control2, end, 0)
  return points
}

export function appendWithoutDuplicate(target: Point[], points: readonly Point[]): void {
  for (const point of points) {
    const previous = target.at(-1)
    if (!previous || Math.hypot(previous.x - point.x, previous.y - point.y) > 1e-9) {
      target.push({ ...point })
    }
  }
}
