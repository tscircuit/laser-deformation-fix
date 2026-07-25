import { access, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, extname, join } from "node:path"
import { constants } from "node:fs"
import { OutsideBoundsError, OutputConflictError, TransformValidationError } from "../errors.js"
import { invertMatrix, transformPoint } from "../geometry/affine.js"
import { isSupportedVectorType, shapeToWorldGeometry } from "../geometry/shape-conversion.js"
import {
  findRule,
  parseLayerWarpTransform,
  warpPoint,
} from "../calibration/transform.js"
import type {
  LayerWarpTransform,
  LightBurnDocument,
  LightBurnXmlNode,
  Point,
  ShapeRecord,
  WorldContour,
} from "../types.js"
import { collectShapeRecords, GeometryResolver } from "../xml/geometry-resolver.js"
import { cloneNode, removeChildren, setTextElement } from "../xml/node-utils.js"
import { parseLightBurn } from "../xml/parse-lightburn.js"
import { formatNumber, serializeLightBurn } from "../xml/serialize-lightburn.js"

export interface ApplyOptions {
  segmentLength?: number
  allowOutside?: boolean
}

export interface ApplyResult {
  document: LightBurnDocument
  correctedShapeCount: number
  translatedShapeCount: number
  nonlinearShapeCount: number
  outsidePointCount: number
  unchangedTypes: Record<string, number>
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
  shape.element.attributes.Type = "Path"
  for (const attribute of ["W", "H", "Cr", "Rx", "Ry", "N", "VertID", "PrimID"]) {
    delete shape.element.attributes[attribute]
  }
  removeChildren(shape.element, new Set(["VertList", "PrimList", "V", "P"]))
  setTextElement(shape.element, "XForm", "1 0 0 1 0 0")
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
  if (document.format === "lbrn2") {
    shape.element.children.push({
      kind: "element", name: "VertList", attributes: {},
      children: [{
        kind: "text",
        value: vertices.map((point) => `V${formatNumber(point.x)} ${formatNumber(point.y)}`).join(""),
      }],
    })
    shape.element.children.push({
      kind: "element", name: "PrimList", attributes: {},
      children: [{
        kind: "text",
        value: primitives.map((primitive) => `L${primitive.start} ${primitive.end}`).join(""),
      }],
    })
  } else {
    shape.element.children.push(...vertices.map((point): LightBurnXmlNode => ({
      kind: "element", name: "V",
      attributes: { vx: formatNumber(point.x), vy: formatNumber(point.y) }, children: [],
    })))
    shape.element.children.push(...primitives.map((primitive): LightBurnXmlNode => ({
      kind: "element", name: "P",
      attributes: { T: "L", p0: String(primitive.start), p1: String(primitive.end) }, children: [],
    })))
  }
}

function removeThumbnails(node: LightBurnXmlNode): void {
  node.children = node.children.filter((child) => child.kind !== "element" || child.name !== "Thumbnail")
  for (const child of node.children) if (child.kind === "element") removeThumbnails(child)
}

function translateShape(shape: ShapeRecord, dx: number, dy: number): void {
  const inverseParent = invertMatrix(shape.parentTransform)
  const localDx = inverseParent.a * dx + inverseParent.c * dy
  const localDy = inverseParent.b * dx + inverseParent.d * dy
  const matrix = shape.localTransform
  setTextElement(shape.element, "XForm", [
    matrix.a,
    matrix.b,
    matrix.c,
    matrix.d,
    matrix.tx + localDx,
    matrix.ty + localDy,
  ].map(formatNumber).join(" "))
}

export function applyTransformToDocument(
  input: LightBurnDocument,
  transform: LayerWarpTransform,
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
  const shapes = collectShapeRecords(document.root)
  const resolver = new GeometryResolver(shapes)
  const warnings = [...document.warnings]
  const collector = { warnings, warn: (message: string): void => { warnings.push(message) } }
  const unchangedTypes: Record<string, number> = {}
  let outsidePointCount = 0
  let correctedShapeCount = 0
  let translatedShapeCount = 0
  let nonlinearShapeCount = 0
  for (const shape of shapes) {
    if (shape.shapeType === "Group") continue
    const cutIndex = shape.element.attributes.CutIndex ?? ""
    const rule = findRule(transform, cutIndex)
    if (rule.kind === "translation") {
      translateShape(shape, rule.offsetMm[0], rule.offsetMm[1])
      translatedShapeCount++
      correctedShapeCount++
      continue
    }
    if (!isSupportedVectorType(shape.shapeType)) {
      throw new TransformValidationError(
        `Unsupported ${shape.shapeType} shape ${shape.documentOrder} is assigned to `
        + `nonlinear CutIndex ${cutIndex || "(missing)"}`,
      )
    }
    const geometry = shapeToWorldGeometry(shape, resolver, {
      maxSegmentLength: segmentLength,
      flatnessTolerance: Math.min(0.05, segmentLength / 4),
    }, collector)
    if (!geometry) {
      throw new TransformValidationError(
        `Shape ${shape.documentOrder} on nonlinear CutIndex ${cutIndex || "(missing)"} `
        + "could not be converted to path geometry",
      )
    }
    const correctedContours = geometry.contours.map((contour) => ({
      closed: contour.closed,
      points: contour.points.map((point) => {
        const warped = warpPoint(point, transform, cutIndex)
        if (warped.outside) outsidePointCount++
        return warped.point
      }),
    }))
    materializePath(document, shape, correctedContours)
    nonlinearShapeCount++
    correctedShapeCount++
  }
  if (!options.allowOutside && outsidePointCount > 0) {
    throw new OutsideBoundsError(`${outsidePointCount} generated geometry points lie outside calibration bounds`)
  }
  removeThumbnails(document.root)
  for (const [type, count] of Object.entries(unchangedTypes)) {
    const recommendation = type === "Text" ? "; convert text to paths before applying correction" : ""
    warnings.push(`Left ${count} unsupported ${type} object(s) unchanged${recommendation}`)
  }
  document.warnings = warnings
  return {
    document,
    correctedShapeCount,
    translatedShapeCount,
    nonlinearShapeCount,
    outsidePointCount,
    unchangedTypes,
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
  const transform = parseLayerWarpTransform(rawTransform)
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
