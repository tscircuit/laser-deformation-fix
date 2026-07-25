import { GeometryParseError } from "../errors.js"
import type {
  Point,
  ShapeGeometry,
  ShapeRecord,
  WarningCollector,
  WorldContour,
} from "../types.js"
import type { GeometryResolver } from "../xml/geometry-resolver.js"
import { transformPoint } from "./affine.js"
import { pathToWorldContours, type FlattenOptions } from "./paths.js"
import { appendWithoutDuplicate, subdivideLine } from "./subdivision.js"

function finiteAttribute(shape: ShapeRecord, name: string): number {
  const value = Number(shape.element.attributes[name])
  if (!Number.isFinite(value)) {
    throw new GeometryParseError(`${shape.shapeType} shape ${shape.documentOrder} has invalid ${name}`)
  }
  return value
}

function adaptiveParametric(
  pointAt: (t: number) => Point,
  start: number,
  end: number,
  options: FlattenOptions,
  depth = 0,
): Point[] {
  const p0 = pointAt(start)
  const p1 = pointAt(end)
  const midT = (start + end) / 2
  const pm = pointAt(midT)
  const chordMid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }
  const deviation = Math.hypot(pm.x - chordMid.x, pm.y - chordMid.y)
  if (
    depth >= 24
    || (Math.hypot(p1.x - p0.x, p1.y - p0.y) <= options.maxSegmentLength
      && deviation <= options.flatnessTolerance)
  ) return [p0, p1]
  const left = adaptiveParametric(pointAt, start, midT, options, depth + 1)
  const right = adaptiveParametric(pointAt, midT, end, options, depth + 1)
  return [...left.slice(0, -1), ...right]
}

function ellipseContours(shape: ShapeRecord, options: FlattenOptions): WorldContour[] {
  const rx = Math.abs(finiteAttribute(shape, "Rx"))
  const ry = Math.abs(finiteAttribute(shape, "Ry"))
  if (rx <= 0 || ry <= 0) throw new GeometryParseError(`Ellipse ${shape.documentOrder} has non-positive radius`)
  const pointAt = (angle: number): Point => transformPoint(shape.worldTransform, {
    x: rx * Math.cos(angle), y: ry * Math.sin(angle),
  })
  const points: Point[] = []
  for (let quadrant = 0; quadrant < 4; quadrant++) {
    appendWithoutDuplicate(points, adaptiveParametric(
      pointAt,
      quadrant * Math.PI / 2,
      (quadrant + 1) * Math.PI / 2,
      options,
    ))
  }
  if (Math.hypot(points[0]!.x - points.at(-1)!.x, points[0]!.y - points.at(-1)!.y) < 1e-9) points.pop()
  return [{ points, closed: true }]
}

function polygonContours(shape: ShapeRecord, options: FlattenOptions): WorldContour[] {
  const rx = Math.abs(finiteAttribute(shape, "Rx"))
  const ry = Math.abs(finiteAttribute(shape, "Ry"))
  const sides = Math.trunc(finiteAttribute(shape, "N"))
  if (rx <= 0 || ry <= 0 || sides < 3) throw new GeometryParseError(`Polygon ${shape.documentOrder} is invalid`)
  const corners = Array.from({ length: sides }, (_, index) => transformPoint(shape.worldTransform, {
    x: rx * Math.cos(-Math.PI / 2 + index * 2 * Math.PI / sides),
    y: ry * Math.sin(-Math.PI / 2 + index * 2 * Math.PI / sides),
  }))
  const points: Point[] = []
  for (let index = 0; index < sides; index++) {
    appendWithoutDuplicate(points, subdivideLine(corners[index]!, corners[(index + 1) % sides]!, options.maxSegmentLength))
  }
  if (Math.hypot(points[0]!.x - points.at(-1)!.x, points[0]!.y - points.at(-1)!.y) < 1e-9) points.pop()
  return [{ points, closed: true }]
}

function rectangleContours(
  shape: ShapeRecord,
  options: FlattenOptions,
  warnings: WarningCollector,
): WorldContour[] | undefined {
  const width = Math.abs(finiteAttribute(shape, "W"))
  const height = Math.abs(finiteAttribute(shape, "H"))
  const radius = Number(shape.element.attributes.Cr ?? 0)
  if (width <= 0 || height <= 0 || !Number.isFinite(radius)) {
    throw new GeometryParseError(`Rectangle ${shape.documentOrder} has invalid dimensions`)
  }
  if (radius < 0) {
    warnings.warn(`Rectangle ${shape.documentOrder} has an unsupported negative corner radius and was left unchanged`)
    return undefined
  }
  const r = Math.min(radius, width / 2, height / 2)
  if (r === 0) {
    const corners = [
      { x: -width / 2, y: -height / 2 }, { x: width / 2, y: -height / 2 },
      { x: width / 2, y: height / 2 }, { x: -width / 2, y: height / 2 },
    ].map((point) => transformPoint(shape.worldTransform, point))
    const points: Point[] = []
    for (let index = 0; index < 4; index++) {
      appendWithoutDuplicate(points, subdivideLine(corners[index]!, corners[(index + 1) % 4]!, options.maxSegmentLength))
    }
    if (Math.hypot(points[0]!.x - points.at(-1)!.x, points[0]!.y - points.at(-1)!.y) < 1e-9) points.pop()
    return [{ points, closed: true }]
  }
  const centers = [
    { x: width / 2 - r, y: -height / 2 + r, start: -Math.PI / 2 },
    { x: width / 2 - r, y: height / 2 - r, start: 0 },
    { x: -width / 2 + r, y: height / 2 - r, start: Math.PI / 2 },
    { x: -width / 2 + r, y: -height / 2 + r, start: Math.PI },
  ]
  const points: Point[] = []
  for (const center of centers) {
    const pointAt = (angle: number): Point => transformPoint(shape.worldTransform, {
      x: center.x + r * Math.cos(angle), y: center.y + r * Math.sin(angle),
    })
    appendWithoutDuplicate(points, adaptiveParametric(pointAt, center.start, center.start + Math.PI / 2, options))
  }
  if (Math.hypot(points[0]!.x - points.at(-1)!.x, points[0]!.y - points.at(-1)!.y) < 1e-9) points.pop()
  return [{ points, closed: true }]
}

export function shapeToWorldGeometry(
  shape: ShapeRecord,
  resolver: GeometryResolver,
  options: FlattenOptions,
  warnings: WarningCollector,
): ShapeGeometry | undefined {
  let contours: WorldContour[] | undefined
  switch (shape.shapeType) {
    case "Path": contours = pathToWorldContours(resolver.resolve(shape), shape.worldTransform, options); break
    case "Rect":
    case "Rectangle": contours = rectangleContours(shape, options, warnings); break
    case "Ellipse": contours = ellipseContours(shape, options); break
    case "Polygon": contours = polygonContours(shape, options); break
    default: return undefined
  }
  return contours ? { shape, contours } : undefined
}

export function isSupportedVectorType(type: string): boolean {
  return type === "Path" || type === "Rect" || type === "Rectangle" || type === "Ellipse" || type === "Polygon"
}
