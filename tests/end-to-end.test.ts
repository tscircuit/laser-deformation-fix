import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { buildCorrespondences } from "../src/calibration/correspondences.js"
import { applyCommand, applyTransformToDocument } from "../src/commands/apply.js"
import { learnCommand } from "../src/commands/learn.js"
import { verifyCommand } from "../src/commands/verify.js"
import type { CoefficientMatrix4, LayerWarpTransform } from "../src/types.js"
import { transformPoint } from "../src/geometry/affine.js"
import { collectShapeRecords, GeometryResolver } from "../src/xml/geometry-resolver.js"
import { parseLightBurn } from "../src/xml/parse-lightburn.js"
import { serializeLightBurn } from "../src/xml/serialize-lightburn.js"

const temporaryDirectories: string[] = []
afterEach(async () => Promise.all(
  temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
))

const zeros = (): CoefficientMatrix4 => [
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
]

function testTransform(): LayerWarpTransform {
  const xCoefficients = zeros()
  const yCoefficients = zeros()
  xCoefficients[1][0] = 10
  yCoefficients[0][1] = 10
  return {
    format: "lightburn-layer-warp-v2",
    sourceBoundsMm: [0, 0, 10, 10],
    coordinateFrame: { mirrorX: false, mirrorY: false },
    defaultRule: { kind: "translation", offsetMm: [3, 4] },
    rules: [{ kind: "bicubic", cutIndexes: ["6"], xCoefficients, yCoefficients }],
    fit: {
      matchedPathCount: 1,
      matchedPointCount: 16,
      excludedPathCount: 0,
      matrixRank: 16,
      rmsErrorMm: 0,
      meanErrorMm: 0,
      maxErrorMm: 0,
    },
    verification: {
      matchedPathCount: 1,
      maxSymmetricHausdorffMm: 0,
      toleranceMm: 0.01,
    },
  }
}

function project(shapes: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>`
    + `<LightBurnProject FormatVersion="1" MirrorX="False" MirrorY="False">`
    + `${shapes}</LightBurnProject>`
}

describe("V3 learning and verification", () => {
  test("classifies layers, fits the direct vertices, applies, and verifies every path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "layer-warp-v3-"))
    temporaryDirectories.push(directory)
    const originalPath = join(import.meta.dir, "..", "samples", "led_test_V3.lbrn2")
    const correctedPath = join(
      import.meta.dir,
      "..",
      "samples",
      "deformation_corrected_led_test_V3.lbrn2",
    )
    const transformPath = join(directory, "transform.json")
    const outputPath = join(directory, "output.lbrn2")
    const learned = await learnCommand(originalPath, correctedPath, transformPath)
    expect(learned.defaultTranslation.x).toBeCloseTo(83.8897335015, 9)
    expect(learned.defaultTranslation.y).toBeCloseTo(60.3908395, 9)
    expect(learned.nonlinearCutIndexes).toEqual(["6", "16", "30"])
    expect(learned.transform.fit.matchedPointCount).toBe(1462)
    expect(learned.transform.fit.excludedPathCount).toBe(3)
    expect(learned.transform.fit.matrixRank).toBe(16)
    expect(learned.transform.fit.maxErrorMm).toBeLessThan(0.0001)
    expect(learned.transform.verification.matchedPathCount).toBe(90)
    expect(learned.transform.verification.maxSymmetricHausdorffMm).toBeLessThanOrEqual(0.01)

    const applied = await applyCommand(transformPath, originalPath, outputPath)
    expect(applied.translatedShapeCount).toBe(61)
    expect(applied.nonlinearShapeCount).toBe(29)
    expect(applied.outsidePointCount).toBe(0)
    const output = parseLightBurn(await readFile(outputPath, "utf8"), outputPath)
    const outputShapes = collectShapeRecords(output.root)
    expect(outputShapes.filter((shape) => shape.shapeType === "Path")).toHaveLength(90)
    const original = parseLightBurn(await readFile(originalPath, "utf8"), originalPath)
    const originalShapes = collectShapeRecords(original.root)
      .filter((shape) => shape.shapeType === "Path")
    const originalResolver = new GeometryResolver(originalShapes)
    const outputResolver = new GeometryResolver(outputShapes)
    for (const cutIndex of ["0", "2", "3", "4", "8", "10", "14"]) {
      const sourceLayer = originalShapes.filter(
        (shape) => shape.element.attributes.CutIndex === cutIndex,
      )
      const outputLayer = outputShapes.filter(
        (shape) => shape.element.attributes.CutIndex === cutIndex,
      )
      expect(outputLayer).toHaveLength(sourceLayer.length)
      sourceLayer.forEach((sourceShape, pathIndex) => {
        const outputShape = outputLayer[pathIndex]!
        const sourcePath = originalResolver.resolve(sourceShape)
        const outputPathGeometry = outputResolver.resolve(outputShape)
        expect(outputPathGeometry.vertices).toHaveLength(sourcePath.vertices.length)
        sourcePath.vertices.forEach((vertex, vertexIndex) => {
          const sourcePoint = transformPoint(sourceShape.worldTransform, vertex)
          const outputPoint = transformPoint(
            outputShape.worldTransform,
            outputPathGeometry.vertices[vertexIndex]!,
          )
          expect(outputPoint.x - sourcePoint.x).toBeCloseTo(
            learned.defaultTranslation.x,
            7,
          )
          expect(outputPoint.y - sourcePoint.y).toBeCloseTo(
            learned.defaultTranslation.y,
            7,
          )
        })
      })
    }
    const verified = await verifyCommand(transformPath, originalPath, correctedPath)
    expect(verified.matchedPathCount).toBe(90)
    expect(verified.maxSymmetricHausdorffMm).toBeLessThanOrEqual(0.01)
  })

  test("builds exactly the compatible direct V3 correspondences", async () => {
    const originalPath = join(import.meta.dir, "..", "samples", "led_test_V3.lbrn2")
    const correctedPath = join(
      import.meta.dir,
      "..",
      "samples",
      "deformation_corrected_led_test_V3.lbrn2",
    )
    const [original, corrected] = await Promise.all([
      readFile(originalPath, "utf8").then((xml) => parseLightBurn(xml, originalPath)),
      readFile(correctedPath, "utf8").then((xml) => parseLightBurn(xml, correctedPath)),
    ])
    const result = buildCorrespondences(original, corrected)
    expect(result.matchedShapeCount).toBe(90)
    expect(result.excludedPathCount).toBe(3)
    expect(result.correspondences.filter((item) => (
      ["6", "16", "30"].includes(item.cutIndex)
    ))).toHaveLength(1462)
    expect(result.sourceBoundsMm).toEqual([-50, -35, 50, 35])
  })
})

describe("layer-aware application", () => {
  test("translates supported and unsupported objects without materializing them", () => {
    const input = parseLightBurn(project(`
      <Shape Type="Path" CutIndex="0"><XForm>1 0 0 1 1 2</XForm><VertList>V0 0V1 0</VertList><PrimList>LineOpen</PrimList></Shape>
      <Shape Type="Text" CutIndex="0" Str="hello"><XForm>1 0 0 1 5 6</XForm></Shape>
    `), "translation.lbrn2")
    const result = applyTransformToDocument(input, testTransform())
    const shapes = collectShapeRecords(result.document.root)
    expect(shapes.map((shape) => shape.shapeType)).toEqual(["Path", "Text"])
    expect(shapes[0]!.localTransform.tx).toBe(4)
    expect(shapes[0]!.localTransform.ty).toBe(6)
    expect(shapes[1]!.element.attributes.Str).toBe("hello")
    const reparsedShapes = collectShapeRecords(parseLightBurn(
      serializeLightBurn(result.document),
      "translation-output.lbrn2",
    ).root)
    expect(reparsedShapes[0]!.worldTransform.tx).toBe(4)
    expect(reparsedShapes[1]!.worldTransform.ty).toBe(10)
  })

  test("fails on unsupported shapes assigned to a nonlinear layer", () => {
    const input = parseLightBurn(project(
      '<Shape Type="Text" CutIndex="6" Str="hello"><XForm>1 0 0 1 5 5</XForm></Shape>',
    ), "text.lbrn2")
    expect(() => applyTransformToDocument(input, testTransform())).toThrow("Unsupported Text")
  })

  test("errors outside nonlinear bounds by default and permits an explicit override", () => {
    const input = parseLightBurn(project(
      '<Shape Type="Path" CutIndex="6"><VertList>V0 0V11 0</VertList><PrimList>LineOpen</PrimList></Shape>',
    ), "outside.lbrn2")
    expect(() => applyTransformToDocument(input, testTransform())).toThrow("outside")
    expect(() => applyTransformToDocument(input, testTransform(), { allowOutside: true }))
      .not.toThrow()
  })

  test("materializes nonlinear paths as independently resolvable line geometry", () => {
    const input = parseLightBurn(project(
      '<Shape Type="Path" CutIndex="6"><VertList>V0 0V10 10</VertList><PrimList>LineOpen</PrimList></Shape>',
    ), "nonlinear.lbrn2")
    const result = applyTransformToDocument(input, testTransform(), { segmentLength: 1 })
    const shapes = collectShapeRecords(result.document.root)
    const path = new GeometryResolver(shapes).resolve(shapes[0]!)
    expect(path.vertices.length).toBeGreaterThan(2)
    expect(path.primitives.every((primitive) => primitive.kind === "line")).toBe(true)
  })
})
