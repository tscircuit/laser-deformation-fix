import { z } from "zod"
import { TransformValidationError } from "../errors.js"
import type {
  CoefficientMatrix4,
  GlobalWarpTransform,
  Point,
} from "../types.js"

const finiteNumber = z.number().refine(Number.isFinite, "must be finite")
const coefficientRow = z.tuple([finiteNumber, finiteNumber, finiteNumber, finiteNumber])
const coefficientMatrix = z.tuple([
  coefficientRow, coefficientRow, coefficientRow, coefficientRow,
])
const pointSchema = z.object({ x: finiteNumber, y: finiteNumber }).strict()
const vertexSchema = z.object({
  x: finiteNumber,
  y: finiteNumber,
  c0: pointSchema.optional(),
  c1: pointSchema.optional(),
}).strict()
const primitiveSchema = z.object({
  kind: z.enum(["line", "cubic-bezier"]),
  startIndex: z.number().int().nonnegative(),
  endIndex: z.number().int().nonnegative(),
}).strict()
const resolvedPathSchema = z.object({
  vertices: z.array(vertexSchema).min(2),
  primitives: z.array(primitiveSchema).min(1),
  closed: z.boolean(),
}).strict().superRefine((path, context) => {
  path.primitives.forEach((primitive, primitiveIndex) => {
    if (
      primitive.startIndex >= path.vertices.length
      || primitive.endIndex >= path.vertices.length
    ) {
      context.addIssue({
        code: "custom",
        message: "primitive references a missing vertex",
        path: ["primitives", primitiveIndex],
      })
    }
    if (
      primitive.kind === "cubic-bezier"
      && (
        !path.vertices[primitive.startIndex]?.c0
        || !path.vertices[primitive.endIndex]?.c1
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "cubic-bezier primitive is missing c0/c1 controls",
        path: ["primitives", primitiveIndex],
      })
    }
  })
})
const toolingPathSchema = z.object({
  sourceNormalized: resolvedPathSchema,
  targetWorld: resolvedPathSchema,
}).strict()
const globalWarpSchema = z.object({
  format: z.literal("lightburn-global-warp-v2"),
  sourceBoundsMm: z.tuple([finiteNumber, finiteNumber, finiteNumber, finiteNumber]),
  coordinateFrame: z.object({ mirrorX: z.boolean(), mirrorY: z.boolean() }).strict(),
  tooling: z.object({
    cutIndex: z.string().min(1),
    paths: z.tuple([
      toolingPathSchema,
      toolingPathSchema,
      toolingPathSchema,
      toolingPathSchema,
    ]),
  }).strict(),
  xCoefficients: coefficientMatrix,
  yCoefficients: coefficientMatrix,
  fit: z.object({
    matchedPathCount: z.number().int().nonnegative(),
    matchedPointCount: z.number().int().nonnegative(),
    excludedPathCount: z.number().int().nonnegative(),
    matrixRank: z.number().int().nonnegative(),
    rmsErrorMm: finiteNumber.nonnegative(),
    meanErrorMm: finiteNumber.nonnegative(),
    maxErrorMm: finiteNumber.nonnegative(),
  }).strict(),
  verification: z.object({
    matchedPathCount: z.number().int().nonnegative(),
    maxSymmetricHausdorffMm: finiteNumber.nonnegative(),
    toleranceMm: finiteNumber.positive(),
  }).strict(),
}).strict().superRefine((value, context) => {
  const [minX, minY, maxX, maxY] = value.sourceBoundsMm
  if (!(maxX > minX && maxY > minY)) {
    context.addIssue({
      code: "custom",
      message: "sourceBoundsMm must have positive width and height",
      path: ["sourceBoundsMm"],
    })
  }
})

export function validateBounds(bounds: [number, number, number, number]): void {
  if (
    bounds.some((value) => !Number.isFinite(value))
    || bounds[2] <= bounds[0]
    || bounds[3] <= bounds[1]
  ) {
    throw new TransformValidationError(
      "Invalid bounds: expected finite xmin ymin xmax ymax with positive size",
    )
  }
}

export function parseGlobalWarpTransform(value: unknown): GlobalWarpTransform {
  if (
    typeof value === "object"
    && value !== null
    && "format" in value
    && value.format === "lightburn-global-warp-v1"
  ) {
    throw new TransformValidationError(
      "Legacy lightburn-global-warp-v1 transforms do not contain tooling anchors; "
      + "relearn the transform with the current version",
    )
  }
  const parsed = globalWarpSchema.safeParse(value)
  if (!parsed.success) {
    throw new TransformValidationError(
      `Invalid transformation JSON: ${z.prettifyError(parsed.error)}`,
    )
  }
  return parsed.data as GlobalWarpTransform
}

export function isOutsideBounds(
  point: Point,
  bounds: [number, number, number, number],
): boolean {
  return point.x < bounds[0] || point.x > bounds[2]
    || point.y < bounds[1] || point.y > bounds[3]
}

export function normalizedCoordinates(
  point: Point,
  bounds: [number, number, number, number],
): Point {
  validateBounds(bounds)
  return {
    x: (point.x - bounds[0]) / (bounds[2] - bounds[0]),
    y: (point.y - bounds[1]) / (bounds[3] - bounds[1]),
  }
}

export function bicubicBasis(
  point: Point,
  bounds: [number, number, number, number],
): number[] {
  const normalized = normalizedCoordinates(point, bounds)
  const xPowers = [1, normalized.x, normalized.x ** 2, normalized.x ** 3]
  const yPowers = [1, normalized.y, normalized.y ** 2, normalized.y ** 3]
  const basis: number[] = []
  for (let xPower = 0; xPower < 4; xPower++) {
    for (let yPower = 0; yPower < 4; yPower++) {
      basis.push(xPowers[xPower]! * yPowers[yPower]!)
    }
  }
  return basis
}

function evaluateCoefficients(
  point: Point,
  bounds: [number, number, number, number],
  coefficients: CoefficientMatrix4,
): number {
  const basis = bicubicBasis(point, bounds)
  let value = 0
  for (let xPower = 0; xPower < 4; xPower++) {
    for (let yPower = 0; yPower < 4; yPower++) {
      value += coefficients[xPower]![yPower]! * basis[xPower * 4 + yPower]!
    }
  }
  return value
}

export function warpPoint(
  point: Point,
  transform: GlobalWarpTransform,
  sourceBounds: [number, number, number, number] = transform.sourceBoundsMm,
): { point: Point; outside: boolean } {
  return {
    point: {
      x: evaluateCoefficients(point, sourceBounds, transform.xCoefficients),
      y: evaluateCoefficients(point, sourceBounds, transform.yCoefficients),
    },
    outside: isOutsideBounds(point, sourceBounds),
  }
}

export function stringifyGlobalWarpTransform(transform: GlobalWarpTransform): string {
  return `${JSON.stringify(transform, null, 2)}\n`
}
