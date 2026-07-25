import { CalibrationError } from "../errors.js"
import { transformPoint } from "../geometry/affine.js"
import type {
  CalibrationCorrespondence,
  LightBurnDocument,
  ResolvedPath,
  ShapeRecord,
} from "../types.js"
import { collectShapeRecords, GeometryResolver } from "../xml/geometry-resolver.js"

export interface MatchedCalibrationPath {
  cutIndex: string
  layerPathIndex: number
  sourceShape: ShapeRecord
  targetShape: ShapeRecord
  sourcePath: ResolvedPath
  targetPath: ResolvedPath
  compatibleForDirectFit: boolean
}

export interface CorrespondenceResult {
  correspondences: CalibrationCorrespondence[]
  matchedPaths: MatchedCalibrationPath[]
  matchedShapeCount: number
  excludedPathCount: number
  sourceBoundsMm: [number, number, number, number]
  warnings: string[]
}

interface LayerPath {
  shape: ShapeRecord
  path: ResolvedPath
}

function pathsByCutIndex(document: LightBurnDocument): Map<string, LayerPath[]> {
  const shapes = collectShapeRecords(document.root)
  const resolver = new GeometryResolver(shapes)
  const result = new Map<string, LayerPath[]>()
  for (const shape of shapes) {
    if (shape.shapeType !== "Path") continue
    const cutIndex = shape.element.attributes.CutIndex ?? ""
    result.set(cutIndex, [
      ...(result.get(cutIndex) ?? []),
      { shape, path: resolver.resolve(shape) },
    ])
  }
  return result
}

function sourceBounds(paths: Iterable<LayerPath[]>): [number, number, number, number] {
  const points = [...paths].flatMap((layer) => layer.flatMap(({ shape, path }) => (
    path.vertices.flatMap((vertex) => [
      transformPoint(shape.worldTransform, vertex),
      ...(vertex.c0 ? [transformPoint(shape.worldTransform, vertex.c0)] : []),
      ...(vertex.c1 ? [transformPoint(shape.worldTransform, vertex.c1)] : []),
    ])
  )))
  if (points.length === 0) throw new CalibrationError("The original project contains no path vertices")
  return [
    Math.min(...points.map((point) => point.x)),
    Math.min(...points.map((point) => point.y)),
    Math.max(...points.map((point) => point.x)),
    Math.max(...points.map((point) => point.y)),
  ]
}

function compatibleTopology(source: ResolvedPath, target: ResolvedPath): boolean {
  return source.closed === target.closed && source.vertices.length === target.vertices.length
}

export function buildCorrespondences(
  original: LightBurnDocument,
  corrected: LightBurnDocument,
): CorrespondenceResult {
  if (original.mirrorX !== corrected.mirrorX) {
    throw new CalibrationError("Original and corrected MirrorX settings differ")
  }
  if (original.mirrorY !== corrected.mirrorY) {
    throw new CalibrationError("Original and corrected MirrorY settings differ")
  }
  const source = pathsByCutIndex(original)
  const target = pathsByCutIndex(corrected)
  const allCutIndexes = [...new Set([...source.keys(), ...target.keys()])].sort((left, right) => (
    Number(left) - Number(right) || left.localeCompare(right)
  ))
  const matchedPaths: MatchedCalibrationPath[] = []
  const correspondences: CalibrationCorrespondence[] = []
  let excludedPathCount = 0
  for (const cutIndex of allCutIndexes) {
    const sourceLayer = source.get(cutIndex) ?? []
    const targetLayer = target.get(cutIndex) ?? []
    if (sourceLayer.length !== targetLayer.length) {
      throw new CalibrationError(
        `Different path counts on CutIndex ${cutIndex || "(missing)"}: `
        + `${sourceLayer.length} vs ${targetLayer.length}`,
      )
    }
    sourceLayer.forEach((sourceItem, layerPathIndex) => {
      const targetItem = targetLayer[layerPathIndex]!
      const compatibleForDirectFit = compatibleTopology(sourceItem.path, targetItem.path)
      matchedPaths.push({
        cutIndex,
        layerPathIndex,
        sourceShape: sourceItem.shape,
        targetShape: targetItem.shape,
        sourcePath: sourceItem.path,
        targetPath: targetItem.path,
        compatibleForDirectFit,
      })
      if (!compatibleForDirectFit) {
        excludedPathCount++
        return
      }
      sourceItem.path.vertices.forEach((vertex, vertexIndex) => {
        correspondences.push({
          source: transformPoint(sourceItem.shape.worldTransform, vertex),
          target: transformPoint(
            targetItem.shape.worldTransform,
            targetItem.path.vertices[vertexIndex]!,
          ),
          sourceShapeIndex: sourceItem.shape.documentOrder,
          targetShapeIndex: targetItem.shape.documentOrder,
          cutIndex,
          layerPathIndex,
        })
      })
    })
  }
  return {
    correspondences,
    matchedPaths,
    matchedShapeCount: matchedPaths.length,
    excludedPathCount,
    sourceBoundsMm: sourceBounds(source.values()),
    warnings: [...original.warnings, ...corrected.warnings],
  }
}
