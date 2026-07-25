import { readFile } from "node:fs/promises"
import { contourBounds } from "../geometry/paths.js"
import { isSupportedVectorType, shapeToWorldGeometry } from "../geometry/shape-conversion.js"
import type { LightBurnDocument } from "../types.js"
import {
  collectShapeRecords,
  countSharedReferences,
  GeometryResolver,
} from "../xml/geometry-resolver.js"
import { parseLightBurn } from "../xml/parse-lightburn.js"

export interface InspectionReport {
  format: string
  shapeCounts: Record<string, number>
  usableVectorShapes: number
  paths: number
  vertices: number
  primitives: number
  sharedVertReferences: number
  sharedPrimReferences: number
  mirrorX: boolean
  mirrorY: boolean
  unsupportedObjectTypes: Record<string, number>
  bounds?: [number, number, number, number]
  warnings: string[]
}

export function inspectDocument(document: LightBurnDocument): InspectionReport {
  const shapes = collectShapeRecords(document.root)
  const resolver = new GeometryResolver(shapes)
  const shapeCounts: Record<string, number> = {}
  const unsupportedObjectTypes: Record<string, number> = {}
  const warnings = [...document.warnings]
  const collector = { warnings, warn: (message: string): void => { warnings.push(message) } }
  let vertices = 0
  let primitives = 0
  let usableVectorShapes = 0
  const allBounds: Array<[number, number, number, number]> = []
  for (const shape of shapes) {
    shapeCounts[shape.shapeType] = (shapeCounts[shape.shapeType] ?? 0) + 1
    if (shape.shapeType === "Group") continue
    if (!isSupportedVectorType(shape.shapeType)) {
      unsupportedObjectTypes[shape.shapeType] = (unsupportedObjectTypes[shape.shapeType] ?? 0) + 1
      continue
    }
    if (shape.shapeType === "Path") {
      const path = resolver.resolve(shape)
      vertices += path.vertices.length
      primitives += path.primitives.length
    }
    const geometry = shapeToWorldGeometry(
      shape, resolver, { maxSegmentLength: 1, flatnessTolerance: 0.05 }, collector,
    )
    if (geometry) {
      usableVectorShapes++
      allBounds.push(contourBounds(geometry.contours))
    }
  }
  const bounds = allBounds.length > 0 ? [
    Math.min(...allBounds.map((value) => value[0])),
    Math.min(...allBounds.map((value) => value[1])),
    Math.max(...allBounds.map((value) => value[2])),
    Math.max(...allBounds.map((value) => value[3])),
  ] as [number, number, number, number] : undefined
  return {
    format: document.format,
    shapeCounts,
    usableVectorShapes,
    paths: shapeCounts.Path ?? 0,
    vertices,
    primitives,
    sharedVertReferences: countSharedReferences(shapes, "VertID"),
    sharedPrimReferences: countSharedReferences(shapes, "PrimID"),
    mirrorX: document.mirrorX,
    mirrorY: document.mirrorY,
    unsupportedObjectTypes,
    ...(bounds ? { bounds } : {}),
    warnings,
  }
}

export async function inspectCommand(path: string): Promise<InspectionReport> {
  return inspectDocument(parseLightBurn(await readFile(path, "utf8"), path))
}
