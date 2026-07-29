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

export interface GlobalWarpTransform {
  format: "lightburn-global-warp-v2"
  /** Tooling bounds used to normalize the calibration source geometry. */
  sourceBoundsMm: [number, number, number, number]
  coordinateFrame: {
    mirrorX: boolean
    mirrorY: boolean
  }
  tooling: {
    cutIndex: string
    paths: [
      ToolingPathTransform,
      ToolingPathTransform,
      ToolingPathTransform,
      ToolingPathTransform,
    ]
  }
  /** Absolute output X coefficients, indexed as [xPower][yPower]. */
  xCoefficients: CoefficientMatrix4
  /** Absolute output Y coefficients, indexed as [xPower][yPower]. */
  yCoefficients: CoefficientMatrix4
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

export interface ToolingPathTransform {
  /** Calibration-source path in coordinates normalized to the tooling bounds. */
  sourceNormalized: ResolvedPath
  /** Corrected calibration path in absolute LightBurn world coordinates. */
  targetWorld: ResolvedPath
}
