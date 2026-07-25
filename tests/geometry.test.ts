import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  identityMatrix,
  invertMatrix,
  multiplyMatrices,
  transformPoint,
} from "../src/geometry/affine.js"
import { flattenCubicBezier, subdivideLine } from "../src/geometry/subdivision.js"
import { parseLightBurn } from "../src/xml/parse-lightburn.js"
import { collectShapeRecords, GeometryResolver } from "../src/xml/geometry-resolver.js"
import { boundsCenter, contourBounds } from "../src/geometry/paths.js"
import { shapeToWorldGeometry } from "../src/geometry/shape-conversion.js"

describe("geometry", () => {
  test("composes nested affine transforms in parent-child order", async () => {
    const xml = await readFile(join(import.meta.dir, "..", "fixtures", "nested-groups.lbrn2"), "utf8")
    const records = collectShapeRecords(parseLightBurn(xml, "nested-groups.lbrn2").root)
    const path = records.find((record) => record.shapeType === "Path")!
    expect(transformPoint(path.worldTransform, { x: 0, y: 0 })).toEqual({ x: 12, y: 22 })
  })

  test("inverts an affine matrix", () => {
    const matrix = { a: 2, b: 0.5, c: -0.25, d: 3, tx: 7, ty: -4 }
    const product = multiplyMatrices(matrix, invertMatrix(matrix))
    expect(product.a).toBeCloseTo(identityMatrix().a, 12)
    expect(product.d).toBeCloseTo(identityMatrix().d, 12)
    expect(product.tx).toBeCloseTo(0, 12)
    expect(product.ty).toBeCloseTo(0, 12)
  })

  test("rejects singular inversion", () => {
    expect(() => invertMatrix({ a: 1, b: 2, c: 2, d: 4, tx: 0, ty: 0 })).toThrow("singular")
  })

  test("subdivides lines and cubic curves", () => {
    expect(subdivideLine({ x: 0, y: 0 }, { x: 2, y: 0 }, 0.5)).toHaveLength(5)
    const curve = flattenCubicBezier(
      { x: 0, y: 0 }, { x: 0, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 0 },
      { maxSegmentLength: 0.5, flatnessTolerance: 0.01 },
    )
    expect(curve.length).toBeGreaterThan(5)
    expect(curve[0]).toEqual({ x: 0, y: 0 })
    expect(curve.at(-1)).toEqual({ x: 2, y: 0 })
  })

  test("extracts a path center in world coordinates", async () => {
    const xml = await readFile(join(import.meta.dir, "..", "fixtures", "simple-path.lbrn2"), "utf8")
    const document = parseLightBurn(xml, "simple-path.lbrn2")
    const shapes = collectShapeRecords(document.root)
    const geometry = shapeToWorldGeometry(
      shapes[0]!, new GeometryResolver(shapes),
      { maxSegmentLength: 0.5, flatnessTolerance: 0.01 },
      { warnings: [], warn: () => undefined },
    )!
    expect(boundsCenter(contourBounds(geometry.contours))).toEqual({ x: 55.75, y: 45 })
  })

  test("converts and subdivides a polygon", () => {
    const xml = '<?xml version="1.0"?><LightBurnProject MirrorX="False" MirrorY="False"><Shape Type="Polygon" Rx="5" Ry="5" N="6"><XForm>1 0 0 1 10 10</XForm></Shape></LightBurnProject>'
    const document = parseLightBurn(xml, "polygon.lbrn2")
    const shapes = collectShapeRecords(document.root)
    const geometry = shapeToWorldGeometry(
      shapes[0]!, new GeometryResolver(shapes),
      { maxSegmentLength: 1, flatnessTolerance: 0.05 },
      { warnings: [], warn: () => undefined },
    )!
    expect(geometry.contours[0]!.closed).toBe(true)
    expect(geometry.contours[0]!.points.length).toBeGreaterThan(6)
  })
})
