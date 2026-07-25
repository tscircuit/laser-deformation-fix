export interface Point {
  x: number
  y: number
}

export interface Vertex {
  x: number
  y: number
  c0?: Point
  c1?: Point
}

export type PrimitiveKind = "line" | "cubic-bezier"

export interface Primitive {
  kind: PrimitiveKind
  startIndex: number
  endIndex: number
}

export interface AffineMatrix {
  a: number
  b: number
  c: number
  d: number
  tx: number
  ty: number
}

export interface LightBurnXmlText {
  kind: "text"
  value: string
}

export interface LightBurnXmlComment {
  kind: "comment"
  value: string
}

export type LightBurnXmlContent =
  | LightBurnXmlNode
  | LightBurnXmlText
  | LightBurnXmlComment

export interface LightBurnXmlNode {
  kind: "element"
  name: string
  attributes: Record<string, string>
  children: LightBurnXmlContent[]
}

export type LightBurnFormat = "lbrn2" | "lbrn"

export interface LightBurnDocument {
  root: LightBurnXmlNode
  format: LightBurnFormat
  declaration: Record<string, string>
  mirrorX: boolean
  mirrorY: boolean
  warnings: string[]
}

export interface ShapeRecord {
  element: LightBurnXmlNode
  shapeType: string
  parentTransform: AffineMatrix
  localTransform: AffineMatrix
  worldTransform: AffineMatrix
  documentOrder: number
}

export interface ResolvedPath {
  vertices: Vertex[]
  primitives: Primitive[]
  closed: boolean
}

export interface CalibrationCorrespondence {
  source: Point
  target: Point
  sourceShapeIndex: number
  targetShapeIndex: number
  cutIndex: string
  layerPathIndex: number
}

export type CoefficientMatrix4 = [
  [number, number, number, number],
  [number, number, number, number],
  [number, number, number, number],
  [number, number, number, number],
]

export interface TranslationTransformRule {
  kind: "translation"
  offsetMm: [number, number]
}

export interface BicubicTransformRule {
  kind: "bicubic"
  cutIndexes: string[]
  /** Coefficients for absolute output X, indexed as [xPower][yPower]. */
  xCoefficients: CoefficientMatrix4
  /** Coefficients for absolute output Y, indexed as [xPower][yPower]. */
  yCoefficients: CoefficientMatrix4
}

export interface LayerWarpTransform {
  format: "lightburn-layer-warp-v2"
  sourceBoundsMm: [number, number, number, number]
  coordinateFrame: {
    mirrorX: boolean
    mirrorY: boolean
  }
  defaultRule: TranslationTransformRule
  /** Rules are evaluated in array order. */
  rules: BicubicTransformRule[]
  fit: {
    matchedPathCount: number
    matchedPointCount: number
    excludedPathCount: number
    matrixRank: number
    rmsErrorMm: number
    meanErrorMm: number
    maxErrorMm: number
  }
  verification: {
    matchedPathCount: number
    maxSymmetricHausdorffMm: number
    toleranceMm: number
  }
}

export interface WarningCollector {
  warnings: string[]
  warn(message: string): void
}

export interface WorldContour {
  points: Point[]
  closed: boolean
}

export interface ShapeGeometry {
  shape: ShapeRecord
  contours: WorldContour[]
}
