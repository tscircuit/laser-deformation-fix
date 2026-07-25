import { GeometryParseError, GeometryReferenceError } from "../errors.js"
import { multiplyMatrices, identityMatrix, parseXForm } from "../geometry/affine.js"
import type {
  LightBurnXmlNode,
  Primitive,
  ResolvedPath,
  ShapeRecord,
  Vertex,
} from "../types.js"
import { childElements, firstChild, textContent } from "./node-utils.js"

const NUMBER_SOURCE = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?"
const VERTEX_START = new RegExp(`V(?=${NUMBER_SOURCE})`, "g")
const VERTEX_HEAD = new RegExp(`^V(${NUMBER_SOURCE})\\s+(${NUMBER_SOURCE})`)
const CONTROL = new RegExp(`^(c[01][xy])(${NUMBER_SOURCE})`)
const PRIMITIVE = /^([LB])(\d+)\s+(\d+)/

export function parseVertList(value: string): Vertex[] {
  const starts = [...value.matchAll(VERTEX_START)].map((match) => match.index)
  if (starts.length === 0) throw new GeometryParseError("Malformed VertList: no vertex records")
  const vertices: Vertex[] = []
  for (let index = 0; index < starts.length; index++) {
    const start = starts[index]!
    const end = starts[index + 1] ?? value.length
    let record = value.slice(start, end).trim()
    const head = VERTEX_HEAD.exec(record)
    if (!head) throw new GeometryParseError(`Malformed VertList near offset ${start}`)
    const x = Number(head[1])
    const y = Number(head[2])
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new GeometryParseError(`Non-finite vertex near offset ${start}`)
    }
    record = record.slice(head[0].length).trim()
    const controls: Partial<Record<"c0x" | "c0y" | "c1x" | "c1y", number>> = {}
    while (record.length > 0) {
      if (record.startsWith("S")) {
        record = record.slice(1).trim()
        continue
      }
      const control = CONTROL.exec(record)
      if (!control) throw new GeometryParseError(`Malformed VertList control data near offset ${start}`)
      const key = control[1] as "c0x" | "c0y" | "c1x" | "c1y"
      controls[key] = Number(control[2])
      record = record.slice(control[0].length).trim()
    }
    const vertex: Vertex = { x, y }
    if (controls.c0x !== undefined && controls.c0y !== undefined) {
      vertex.c0 = { x: controls.c0x, y: controls.c0y }
    }
    if (controls.c1x !== undefined && controls.c1y !== undefined) {
      vertex.c1 = { x: controls.c1x, y: controls.c1y }
    }
    vertices.push(vertex)
  }
  return vertices
}

function samePoint(a: Vertex, b: Vertex): boolean {
  return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9
}

export function parsePrimList(value: string, vertices: Vertex[]): { primitives: Primitive[]; closed: boolean } {
  const trimmed = value.trim()
  if (trimmed === "LineClosed" || trimmed === "LineOpen") {
    if (vertices.length < 2) throw new GeometryParseError(`${trimmed} requires at least two vertices`)
    const primitives: Primitive[] = []
    for (let index = 0; index < vertices.length - 1; index++) {
      primitives.push({ kind: "line", startIndex: index, endIndex: index + 1 })
    }
    const closed = trimmed === "LineClosed"
    if (closed && !samePoint(vertices[0]!, vertices.at(-1)!)) {
      primitives.push({ kind: "line", startIndex: vertices.length - 1, endIndex: 0 })
    }
    return { primitives, closed }
  }
  const primitives: Primitive[] = []
  let rest = trimmed
  let offset = 0
  while (rest.length > 0) {
    const whitespace = /^\s+/.exec(rest)
    if (whitespace) {
      offset += whitespace[0].length
      rest = rest.slice(whitespace[0].length)
      continue
    }
    const match = PRIMITIVE.exec(rest)
    if (!match) throw new GeometryParseError(`Malformed PrimList near offset ${offset}`)
    const startIndex = Number(match[2])
    const endIndex = Number(match[3])
    if (startIndex >= vertices.length || endIndex >= vertices.length) {
      throw new GeometryParseError(`PrimList references missing vertex near offset ${offset}`)
    }
    const kind = match[1] === "L" ? "line" : "cubic-bezier"
    if (kind === "cubic-bezier" && (!vertices[startIndex]?.c0 || !vertices[endIndex]?.c1)) {
      throw new GeometryParseError(`Bézier primitive ${startIndex}→${endIndex} is missing c0/c1 controls`)
    }
    primitives.push({ kind, startIndex, endIndex })
    offset += match[0].length
    rest = rest.slice(match[0].length)
  }
  if (primitives.length === 0) throw new GeometryParseError("Malformed PrimList: no primitives")
  return {
    primitives,
    closed: primitives.at(-1)?.endIndex === primitives[0]?.startIndex,
  }
}

export function collectShapeRecords(root: LightBurnXmlNode): ShapeRecord[] {
  const records: ShapeRecord[] = []
  let documentOrder = 0
  const visitContainer = (container: LightBurnXmlNode, parentTransform = identityMatrix()): void => {
    for (const element of childElements(container)) {
      if (element.name !== "Shape") {
        if (element.name !== "BackupShape") visitContainer(element, parentTransform)
        continue
      }
      const localTransform = parseXForm(textContent(firstChild(element, "XForm")))
      const worldTransform = multiplyMatrices(parentTransform, localTransform)
      const record: ShapeRecord = {
        element,
        shapeType: element.attributes.Type ?? "Unknown",
        parentTransform,
        localTransform,
        worldTransform,
        documentOrder: documentOrder++,
      }
      records.push(record)
      const children = firstChild(element, "Children")
      if (children) visitContainer(children, worldTransform)
    }
  }
  visitContainer(root)
  return records
}

export class GeometryResolver {
  private readonly vertexDefinitions = new Map<string, string>()
  private readonly primitiveDefinitions = new Map<string, string>()

  constructor(private readonly shapes: readonly ShapeRecord[]) {
    for (const shape of shapes) {
      if (shape.shapeType !== "Path") continue
      this.indexDefinition(shape, "VertID", "VertList", this.vertexDefinitions)
      this.indexDefinition(shape, "PrimID", "PrimList", this.primitiveDefinitions)
    }
  }

  private indexDefinition(
    shape: ShapeRecord,
    idAttribute: string,
    elementName: string,
    definitions: Map<string, string>,
  ): void {
    const id = shape.element.attributes[idAttribute]
    const inline = textContent(firstChild(shape.element, elementName))
    if (!id || inline === undefined) return
    const existing = definitions.get(id)
    if (existing !== undefined && existing.trim() !== inline.trim()) {
      throw new GeometryReferenceError(`Conflicting ${elementName} definitions for ${idAttribute}=${id}`)
    }
    definitions.set(id, inline)
  }

  resolve(shape: ShapeRecord): ResolvedPath {
    if (shape.shapeType !== "Path") throw new GeometryReferenceError("Only Path shapes have path geometry")
    const expandedVertices = childElements(shape.element, "V")
    const expandedPrimitives = childElements(shape.element, "P")
    if (expandedVertices.length > 0 || expandedPrimitives.length > 0) {
      if (expandedVertices.length === 0 || expandedPrimitives.length === 0) {
        throw new GeometryParseError(`Legacy path ${shape.documentOrder} has incomplete V/P geometry`)
      }
      const vertices = expandedVertices.map((element, index): Vertex => {
        const x = Number(element.attributes.vx)
        const y = Number(element.attributes.vy)
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          throw new GeometryParseError(`Legacy vertex ${index} on path ${shape.documentOrder} is invalid`)
        }
        const vertex: Vertex = { x, y }
        const c0x = Number(element.attributes.c0x)
        const c0y = Number(element.attributes.c0y)
        const c1x = Number(element.attributes.c1x)
        const c1y = Number(element.attributes.c1y)
        if (Number.isFinite(c0x) && Number.isFinite(c0y)) vertex.c0 = { x: c0x, y: c0y }
        if (Number.isFinite(c1x) && Number.isFinite(c1y)) vertex.c1 = { x: c1x, y: c1y }
        return vertex
      })
      const primitives = expandedPrimitives.map((element, index): Primitive => {
        const startIndex = Number(element.attributes.p0)
        const endIndex = Number(element.attributes.p1)
        const type = element.attributes.T
        if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex)
          || startIndex < 0 || endIndex < 0
          || startIndex >= vertices.length || endIndex >= vertices.length
          || (type !== "L" && type !== "B")) {
          throw new GeometryParseError(`Legacy primitive ${index} on path ${shape.documentOrder} is invalid`)
        }
        const kind = type === "L" ? "line" : "cubic-bezier"
        if (kind === "cubic-bezier" && (!vertices[startIndex]?.c0 || !vertices[endIndex]?.c1)) {
          throw new GeometryParseError(`Legacy Bézier ${index} is missing controls`)
        }
        return { kind, startIndex, endIndex }
      })
      return {
        vertices,
        primitives,
        closed: primitives.at(-1)?.endIndex === primitives[0]?.startIndex,
      }
    }
    const vertexText = this.resolveText(shape, "VertID", "VertList", this.vertexDefinitions)
    const primitiveText = this.resolveText(shape, "PrimID", "PrimList", this.primitiveDefinitions)
    const vertices = parseVertList(vertexText)
    const { primitives, closed } = parsePrimList(primitiveText, vertices)
    return {
      vertices: vertices.map((vertex) => ({
        ...vertex,
        ...(vertex.c0 ? { c0: { ...vertex.c0 } } : {}),
        ...(vertex.c1 ? { c1: { ...vertex.c1 } } : {}),
      })),
      primitives: primitives.map((primitive) => ({ ...primitive })),
      closed,
    }
  }

  private resolveText(
    shape: ShapeRecord,
    idAttribute: string,
    elementName: string,
    definitions: Map<string, string>,
  ): string {
    const inline = textContent(firstChild(shape.element, elementName))
    if (inline !== undefined) return inline
    const id = shape.element.attributes[idAttribute]
    if (!id) throw new GeometryReferenceError(`Path ${shape.documentOrder} is missing ${elementName}`)
    const resolved = definitions.get(id)
    if (resolved === undefined) {
      throw new GeometryReferenceError(`Unresolved ${idAttribute}=${id} on path ${shape.documentOrder}`)
    }
    return resolved
  }
}

export function countSharedReferences(shapes: readonly ShapeRecord[], attribute: "VertID" | "PrimID"): number {
  const counts = new Map<string, number>()
  for (const shape of shapes) {
    const id = shape.element.attributes[attribute]
    if (shape.shapeType === "Path" && id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return [...counts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0)
}
