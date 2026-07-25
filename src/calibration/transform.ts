import { z } from "zod"
import { TransformValidationError } from "../errors.js"
import type {
  BicubicTransformRule,
  CoefficientMatrix4,
  LayerWarpTransform,
  Point,
  TranslationTransformRule,
} from "../types.js"

const finiteNumber = z.number().refine(Number.isFinite, "must be finite")
const coefficientRow = z.tuple([finiteNumber, finiteNumber, finiteNumber, finiteNumber])
const coefficientMatrix = z.tuple([
  coefficientRow, coefficientRow, coefficientRow, coefficientRow,
])
const translationRuleSchema = z.object({
  kind: z.literal("translation"),
  offsetMm: z.tuple([finiteNumber, finiteNumber]),
}).strict()
const bicubicRuleSchema = z.object({
  kind: z.literal("bicubic"),
  cutIndexes: z.array(z.string()).min(1),
  xCoefficients: coefficientMatrix,
  yCoefficients: coefficientMatrix,
}).strict()

const layerWarpSchema = z.object({
  format: z.literal("lightburn-layer-warp-v2"),
  sourceBoundsMm: z.tuple([finiteNumber, finiteNumber, finiteNumber, finiteNumber]),
  coordinateFrame: z.object({ mirrorX: z.boolean(), mirrorY: z.boolean() }).strict(),
  defaultRule: translationRuleSchema,
  rules: z.array(bicubicRuleSchema),
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
  const seen = new Set<string>()
  value.rules.forEach((rule, ruleIndex) => {
    rule.cutIndexes.forEach((cutIndex, cutIndexPosition) => {
      if (seen.has(cutIndex)) {
        context.addIssue({
          code: "custom",
          message: `CutIndex ${cutIndex} occurs in more than one ordered rule`,
          path: ["rules", ruleIndex, "cutIndexes", cutIndexPosition],
        })
      }
      seen.add(cutIndex)
    })
  })
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

export function parseLayerWarpTransform(value: unknown): LayerWarpTransform {
  const parsed = layerWarpSchema.safeParse(value)
  if (!parsed.success) {
    throw new TransformValidationError(
      `Invalid transformation JSON: ${z.prettifyError(parsed.error)}`,
    )
  }
  return parsed.data
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

export function findRule(
  transform: LayerWarpTransform,
  cutIndex: string,
): BicubicTransformRule | TranslationTransformRule {
  return transform.rules.find((rule) => rule.cutIndexes.includes(cutIndex))
    ?? transform.defaultRule
}

export function warpPoint(
  point: Point,
  transform: LayerWarpTransform,
  cutIndex = "",
): { point: Point; outside: boolean; rule: BicubicTransformRule | TranslationTransformRule } {
  const rule = findRule(transform, cutIndex)
  if (rule.kind === "translation") {
    return {
      point: { x: point.x + rule.offsetMm[0], y: point.y + rule.offsetMm[1] },
      outside: false,
      rule,
    }
  }
  return {
    point: {
      x: evaluateCoefficients(point, transform.sourceBoundsMm, rule.xCoefficients),
      y: evaluateCoefficients(point, transform.sourceBoundsMm, rule.yCoefficients),
    },
    outside: isOutsideBounds(point, transform.sourceBoundsMm),
    rule,
  }
}

export function stringifyLayerWarpTransform(transform: LayerWarpTransform): string {
  return `${JSON.stringify(transform, null, 2)}\n`
}
