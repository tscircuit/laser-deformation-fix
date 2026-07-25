import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { parseLightBurn } from "../src/xml/parse-lightburn.js"
import {
  collectShapeRecords,
  countSharedReferences,
  GeometryResolver,
  parsePrimList,
  parseVertList,
} from "../src/xml/geometry-resolver.js"
import { serializeLightBurn } from "../src/xml/serialize-lightburn.js"
import { pathToWorldContours } from "../src/geometry/paths.js"
import { identityMatrix } from "../src/geometry/affine.js"

const fixture = (name: string) => readFile(join(import.meta.dir, "..", "fixtures", name), "utf8")

describe("LightBurn parsing", () => {
  test("parses a simple packed path with lines and cubic Bézier primitives", async () => {
    const document = parseLightBurn(await fixture("simple-path.lbrn2"), "simple-path.lbrn2")
    const shapes = collectShapeRecords(document.root)
    const path = new GeometryResolver(shapes).resolve(shapes[0]!)
    expect(document.format).toBe("lbrn2")
    expect(path.vertices).toHaveLength(4)
    expect(path.primitives.map((primitive) => primitive.kind)).toEqual([
      "line", "cubic-bezier", "line", "line",
    ])
    expect(path.closed).toBe(true)
  })

  test("parses packed signed decimal and scientific notation vertices", () => {
    const vertices = parseVertList("V-1.5 +2e1V.25 -3.0E-1c0x0c0y1c1x2c1y3S")
    expect(vertices).toEqual([
      { x: -1.5, y: 20 },
      { x: 0.25, y: -0.3, c0: { x: 0, y: 1 }, c1: { x: 2, y: 3 } },
    ])
  })

  test("supports explicit and shorthand primitive lists", () => {
    const vertices = parseVertList("V0 0V1 0V1 1V0 0")
    expect(parsePrimList("L0 1 L1 2L2 3", vertices).primitives).toHaveLength(3)
    expect(parsePrimList("LineClosed", vertices)).toMatchObject({ closed: true })
    expect(parsePrimList("LineOpen", vertices)).toMatchObject({ closed: false })
  })

  test("traverses a Bézier with the starting c0 and ending c1 handles", () => {
    const vertices = parseVertList("V0 0c0x0c0y1V1 0c1x1c1y1")
    const parsed = parsePrimList("B0 1", vertices)
    const contours = pathToWorldContours(
      { vertices, primitives: parsed.primitives, closed: false },
      identityMatrix(),
      { maxSegmentLength: 0.05, flatnessTolerance: 0.0001 },
    )
    expect(Math.max(...contours[0]!.points.map((point) => point.y))).toBeCloseTo(0.75, 3)
    expect(() => parsePrimList(
      "B0 1",
      parseVertList("V0 0c1x0c1y1V1 0c0x1c0y1"),
    )).toThrow("missing c0/c1")
  })

  test("resolves reused forward VertID and PrimID independently", async () => {
    const document = parseLightBurn(await fixture("shared-geometry.lbrn2"), "shared-geometry.lbrn2")
    const shapes = collectShapeRecords(document.root)
    const resolver = new GeometryResolver(shapes)
    const first = resolver.resolve(shapes[0]!)
    const second = resolver.resolve(shapes[1]!)
    first.vertices[0]!.x = 999
    expect(second.vertices[0]!.x).toBe(0)
    expect(countSharedReferences(shapes, "VertID")).toBe(1)
    expect(countSharedReferences(shapes, "PrimID")).toBe(1)
  })

  test("round-trips deterministic generated XML", async () => {
    const document = parseLightBurn(await fixture("simple-path.lbrn2"), "simple-path.lbrn2")
    const first = serializeLightBurn(document)
    const second = serializeLightBurn(parseLightBurn(first, "simple-path.lbrn2"))
    expect(second).toBe(first)
  })

  test("parses and serializes legacy expanded V/P geometry", () => {
    const xml = '<?xml version="1.0"?><LightBurnProject MirrorX="False" MirrorY="False"><Shape Type="Path"><XForm>1 0 0 1 0 0</XForm><V vx="0" vy="0"/><V vx="2" vy="0"/><P T="L" p0="0" p1="1"/></Shape></LightBurnProject>'
    const document = parseLightBurn(xml, "legacy.lbrn")
    const shapes = collectShapeRecords(document.root)
    expect(document.format).toBe("lbrn")
    expect(new GeometryResolver(shapes).resolve(shapes[0]!).primitives).toHaveLength(1)
    expect(() => parseLightBurn(serializeLightBurn(document), "legacy.lbrn")).not.toThrow()
  })

  test("reports malformed and unresolved packed geometry", () => {
    expect(() => parseVertList("Vbad data")).toThrow("no vertex")
    expect(() => parsePrimList("L0 nope", [{ x: 0, y: 0 }])).toThrow("Malformed PrimList")
    const xml = '<?xml version="1.0"?><LightBurnProject><Shape Type="Path" VertID="missing" PrimID="missing"/></LightBurnProject>'
    const document = parseLightBurn(xml, "broken.lbrn2")
    const shapes = collectShapeRecords(document.root)
    expect(() => new GeometryResolver(shapes).resolve(shapes[0]!)).toThrow("Unresolved VertID")
  })
})
