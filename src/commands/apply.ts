import { access, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, extname, join } from "node:path"
import { constants } from "node:fs"
import { OutputConflictError, TransformValidationError } from "../errors.js"
import { invertMatrix, transformPoint } from "../geometry/affine.js"
import { isSupportedVectorType, shapeToWorldGeometry } from "../geometry/shape-conversion.js"
import {
  parseGlobalWarpTransform,
  warpPoint,
} from "../calibration/transform.js"
import {
  extractToolingLayer,
  matchToolingPaths,
  normalizeToolingPath,
} from "../calibration/tooling.js"
import type {
  AffineMatrix,
  GlobalWarpTransform,
  LightBurnDocument,
  LightBurnXmlNode,
  Point,
  ResolvedPath,
  ShapeRecord,
  Vertex,
  WorldContour,
} from "../types.js"
import { collectShapeRecords, GeometryResolver } from "../xml/geometry-resolver.js"
import { cloneNode, removeChildren, setTextElement } from "../xml/node-utils.js"
import { parseLightBurn } from "../xml/parse-lightburn.js"
import { formatNumber, serializeLightBurn } from "../xml/serialize-lightburn.js"

export interface ApplyOptions {
  segmentLength?: number
}

export interface ApplyResult {
  document: LightBurnDocument
  correctedShapeCount: number
  outsidePointCount: number
  warnings: string[]
}

function materializePath(
  document: LightBurnDocument,
  shape: ShapeRecord,
  contours: WorldContour[],
): void {
  const inverseParent = invertMatrix(shape.parentTransform)
  const localContours = contours.map((contour) => ({
    closed: contour.closed,
    points: contour.points.map((point) => transformPoint(inverseParent, point)),
  }))
  const vertices: Point[] = []
  const primitives: Array<{ start: number; end: number }> = []
  for (const contour of localContours) {
    const offset = vertices.length
    vertices.push(...contour.points)
    for (let index = 0; index < contour.points.length - 1; index++) {
      primitives.push({ start: offset + index, end: offset + index + 1 })
    }
    if (contour.closed && contour.points.length > 1) {
      primitives.push({ start: offset + contour.points.length - 1, end: offset })
    }
  }
  writeResolvedPath(document, shape, {
    vertices,
    primitives: primitives.map((primitive) => ({
      kind: "line",
      startIndex: primitive.start,
      endIndex: primitive.end,
    })),
    closed: contours.every((contour) => contour.closed),
  }, { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 })
}

function formatVertex(vertex: Vertex): string {
  return [
    `V${formatNumber(vertex.x)} ${formatNumber(vertex.y)}`,
    ...(vertex.c0 ? [
      `c0x${formatNumber(vertex.c0.x)}`,
      `c0y${formatNumber(vertex.c0.y)}`,
    ] : []),
    ...(vertex.c1 ? [
      `c1x${formatNumber(vertex.c1.x)}`,
      `c1y${formatNumber(vertex.c1.y)}`,
    ] : []),
  ].join("")
}

function formatXForm(matrix: AffineMatrix): string {
  return [
    matrix.a,
    matrix.b,
    matrix.c,
    matrix.d,
    matrix.tx,
    matrix.ty,
  ].map(formatNumber).join(" ")
}

function formatPrimitives(path: ResolvedPath): string {
  const sequentialLines = path.primitives.length === path.vertices.length - 1
    && path.primitives.every((primitive, index) => (
      primitive.kind === "line"
      && primitive.startIndex === index
      && primitive.endIndex === index + 1
    ))
  if (sequentialLines) return path.closed ? "LineClosed" : "LineOpen"
  return path.primitives.map((primitive) => (
    `${primitive.kind === "line" ? "L" : "B"}${primitive.startIndex} ${primitive.endIndex}`
  )).join("")
}

function writeResolvedPath(
  document: LightBurnDocument,
  shape: ShapeRecord,
  path: ResolvedPath,
  localTransform: AffineMatrix,
): void {
  shape.element.attributes.Type = "Path"
  for (const attribute of ["W", "H", "Cr", "Rx", "Ry", "N", "VertID", "PrimID"]) {
    delete shape.element.attributes[attribute]
  }
  removeChildren(shape.element, new Set(["VertList", "PrimList", "V", "P"]))
  setTextElement(shape.element, "XForm", formatXForm(localTransform))
  if (document.format === "lbrn2") {
    shape.element.children.push({
      kind: "element", name: "VertList", attributes: {},
      children: [{
        kind: "text",
        value: path.vertices.map(formatVertex).join(""),
      }],
    })
    shape.element.children.push({
      kind: "element", name: "PrimList", attributes: {},
      children: [{
        kind: "text",
        value: formatPrimitives(path),
      }],
    })
  } else {
    shape.element.children.push(...path.vertices.map((vertex): LightBurnXmlNode => ({
      kind: "element", name: "V",
      attributes: {
        vx: formatNumber(vertex.x),
        vy: formatNumber(vertex.y),
        ...(vertex.c0 ? {
          c0x: formatNumber(vertex.c0.x),
          c0y: formatNumber(vertex.c0.y),
        } : {}),
        ...(vertex.c1 ? {
          c1x: formatNumber(vertex.c1.x),
          c1y: formatNumber(vertex.c1.y),
        } : {}),
      },
      children: [],
    })))
    shape.element.children.push(...path.primitives.map((primitive): LightBurnXmlNode => ({
      kind: "element", name: "P",
      attributes: {
        T: primitive.kind === "line" ? "L" : "B",
        p0: String(primitive.startIndex),
        p1: String(primitive.endIndex),
      },
      children: [],
    })))
  }
}

function removeThumbnails(node: LightBurnXmlNode): void {
  node.children = node.children.filter((child) => child.kind !== "element" || child.name !== "Thumbnail")
  for (const child of node.children) if (child.kind === "element") removeThumbnails(child)
}

export function applyTransformToDocument(
  input: LightBurnDocument,
  transform: GlobalWarpTransform,
  options: ApplyOptions = {},
): ApplyResult {
  if (input.mirrorX !== transform.coordinateFrame.mirrorX || input.mirrorY !== transform.coordinateFrame.mirrorY) {
    throw new TransformValidationError("Input project MirrorX/MirrorY do not match the transformation coordinate frame")
  }
  const segmentLength = options.segmentLength ?? 0.05
  if (!(segmentLength > 0) || !Number.isFinite(segmentLength)) {
    throw new TransformValidationError("--segment-length must be a positive finite number")
  }
  const document: LightBurnDocument = { ...input, root: cloneNode(input.root), warnings: [...input.warnings] }
  const tooling = extractToolingLayer(document, "transform")
  if (tooling.cutIndex !== transform.tooling.cutIndex) {
    throw new TransformValidationError(
      `Input Tool CutIndex ${tooling.cutIndex} does not match transform Tool CutIndex `
      + transform.tooling.cutIndex,
    )
  }
  const normalizedTooling = tooling.paths.map((path) => (
    normalizeToolingPath(path.worldPath, tooling.bounds)
  ))
  const toolingAssignments = matchToolingPaths(normalizedTooling, transform.tooling.paths)
  const toolingShapeOrders = new Set(tooling.paths.map((path) => path.shape.documentOrder))
  const shapes = collectShapeRecords(document.root)
  const resolver = new GeometryResolver(shapes)
  const warnings = [...document.warnings]
  const collector = { warnings, warn: (message: string): void => { warnings.push(message) } }
  const geometries = shapes
    .filter((shape) => (
      shape.shapeType !== "Group"
      && !toolingShapeOrders.has(shape.documentOrder)
    ))
    .map((shape) => {
      if (!isSupportedVectorType(shape.shapeType)) {
        throw new TransformValidationError(
          `Unsupported ${shape.shapeType} shape ${shape.documentOrder}; `
          + "convert it to paths before applying the global correction",
        )
      }
      const geometry = shapeToWorldGeometry(shape, resolver, {
        maxSegmentLength: segmentLength,
        flatnessTolerance: Math.min(0.05, segmentLength / 4),
      }, collector)
      if (!geometry) {
        throw new TransformValidationError(
          `Shape ${shape.documentOrder} could not be converted to path geometry`,
        )
      }
      return geometry
    })
  if (geometries.length === 0) {
    throw new TransformValidationError("Input project contains no supported non-tool vector geometry")
  }
  let outsidePointCount = 0
  let correctedShapeCount = 0
  for (const geometry of geometries) {
    const correctedContours = geometry.contours.map((contour) => ({
      closed: contour.closed,
      points: contour.points.map((point) => {
        const warped = warpPoint(point, transform, tooling.bounds)
        if (warped.outside) outsidePointCount++
        return warped.point
      }),
    }))
    materializePath(document, geometry.shape, correctedContours)
    correctedShapeCount++
  }
  tooling.paths.forEach((path, index) => {
    const template = transform.tooling.paths[toolingAssignments[index]!]!
    writeResolvedPath(
      document,
      path.shape,
      template.targetWorld,
      invertMatrix(path.shape.parentTransform),
    )
    correctedShapeCount++
  })
  removeThumbnails(document.root)
  document.warnings = warnings
  return {
    document,
    correctedShapeCount,
    outsidePointCount,
    warnings,
  }
}

async function exists(path: string): Promise<boolean> {
  try { await access(path, constants.F_OK); return true } catch { return false }
}

export async function applyCommand(
  transformPath: string,
  inputPath: string,
  outputPath: string,
  options: ApplyOptions & { overwrite?: boolean } = {},
): Promise<ApplyResult> {
  if (extname(inputPath).toLowerCase() !== extname(outputPath).toLowerCase()) {
    throw new OutputConflictError("Input and output must use the same .lbrn2 or .lbrn extension")
  }
  if (!options.overwrite && await exists(outputPath)) {
    throw new OutputConflictError(`Output file already exists: ${outputPath}; use --overwrite to replace it`)
  }
  let rawTransform: unknown
  try {
    rawTransform = JSON.parse(await readFile(transformPath, "utf8")) as unknown
  } catch (error) {
    throw new TransformValidationError(
      `Invalid transformation JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const transform = parseGlobalWarpTransform(rawTransform)
  const input = parseLightBurn(await readFile(inputPath, "utf8"), inputPath)
  const result = applyTransformToDocument(input, transform, options)
  const xml = serializeLightBurn(result.document)
  parseLightBurn(xml, outputPath)
  const temporary = join(dirname(outputPath), `.${basename(outputPath)}.${process.pid}.tmp`)
  try {
    await writeFile(temporary, xml, { encoding: "utf8", flag: "wx" })
    await rename(temporary, outputPath)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
  return result
}
