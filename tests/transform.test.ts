import { describe, expect, test } from "bun:test"
import type {
  CalibrationCorrespondence,
  CoefficientMatrix4,
  LayerWarpTransform,
  Point,
} from "../src/types.js"
import { fitBicubic } from "../src/calibration/fit-bicubic.js"
import {
  parseLayerWarpTransform,
  stringifyLayerWarpTransform,
  warpPoint,
} from "../src/calibration/transform.js"

const zeros = (): CoefficientMatrix4 => [
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
]

function knownTransform(): LayerWarpTransform {
  const xCoefficients = zeros()
  const yCoefficients = zeros()
  xCoefficients[0][0] = 20
  xCoefficients[1][0] = 10
  xCoefficients[1][1] = 2
  yCoefficients[0][0] = -5
  yCoefficients[0][1] = 10
  yCoefficients[2][0] = -1
  return {
    format: "lightburn-layer-warp-v2",
    sourceBoundsMm: [0, 0, 10, 10],
    coordinateFrame: { mirrorX: false, mirrorY: false },
    defaultRule: { kind: "translation", offsetMm: [3, 4] },
    rules: [{ kind: "bicubic", cutIndexes: ["6"], xCoefficients, yCoefficients }],
    fit: {
      matchedPathCount: 0,
      matchedPointCount: 0,
      excludedPathCount: 0,
      matrixRank: 16,
      rmsErrorMm: 0,
      meanErrorMm: 0,
      maxErrorMm: 0,
    },
    verification: {
      matchedPathCount: 0,
      maxSymmetricHausdorffMm: 0,
      toleranceMm: 0.01,
    },
  }
}

describe("layer-aware transform", () => {
  test("uses ordered bicubic rules and the default translation", () => {
    const transform = knownTransform()
    expect(warpPoint({ x: 5, y: 5 }, transform, "0").point).toEqual({ x: 8, y: 9 })
    const warped = warpPoint({ x: 5, y: 5 }, transform, "6")
    expect(warped.point.x).toBeCloseTo(25.5, 12)
    expect(warped.point.y).toBeCloseTo(-0.25, 12)
    expect(warped.outside).toBe(false)
    expect(warpPoint({ x: 11, y: 5 }, transform, "6").outside).toBe(true)
  })

  test("recovers a known absolute bicubic mapping", () => {
    const transform = knownTransform()
    const correspondences: CalibrationCorrespondence[] = []
    for (let row = 0; row < 6; row++) {
      for (let col = 0; col < 6; col++) {
        const source: Point = { x: col * 2, y: row * 2 }
        correspondences.push({
          source,
          target: warpPoint(source, transform, "6").point,
          sourceShapeIndex: correspondences.length,
          targetShapeIndex: correspondences.length,
          cutIndex: "6",
          layerPathIndex: correspondences.length,
        })
      }
    }
    const recovered = fitBicubic(correspondences, [0, 0, 10, 10])
    recovered.xCoefficients.forEach((row, xPower) => row.forEach((value, yPower) => {
      expect(value).toBeCloseTo(transform.rules[0]!.xCoefficients[xPower]![yPower]!, 8)
      expect(recovered.yCoefficients[xPower]![yPower]).toBeCloseTo(
        transform.rules[0]!.yCoefficients[xPower]![yPower]!,
        8,
      )
    }))
    expect(recovered.maxErrorMm).toBeLessThan(1e-9)
  })

  test("rejects rank-deficient bicubic data", () => {
    const correspondences = Array.from({ length: 20 }, (_, index): CalibrationCorrespondence => ({
      source: { x: index / 2, y: 0 },
      target: { x: index / 2 + 1, y: 2 },
      sourceShapeIndex: index,
      targetShapeIndex: index,
      cutIndex: "6",
      layerPathIndex: index,
    }))
    expect(() => fitBicubic(correspondences, [0, 0, 10, 10])).toThrow("Rank-deficient")
  })

  test("validates and serializes v2 JSON deterministically", () => {
    const transform = knownTransform()
    const serialized = stringifyLayerWarpTransform(transform)
    expect(stringifyLayerWarpTransform(parseLayerWarpTransform(JSON.parse(serialized))))
      .toBe(serialized)
    expect(() => parseLayerWarpTransform({ ...transform, format: "lightburn-lens-warp-v1" }))
      .toThrow("Invalid transformation")
  })
})
