import { AffineTransformError } from "../errors.js"
import type { AffineMatrix, Point } from "../types.js"

export function identityMatrix(): AffineMatrix {
  return { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }
}

export function multiplyMatrices(parent: AffineMatrix, child: AffineMatrix): AffineMatrix {
  return {
    a: parent.a * child.a + parent.c * child.b,
    b: parent.b * child.a + parent.d * child.b,
    c: parent.a * child.c + parent.c * child.d,
    d: parent.b * child.c + parent.d * child.d,
    tx: parent.a * child.tx + parent.c * child.ty + parent.tx,
    ty: parent.b * child.tx + parent.d * child.ty + parent.ty,
  }
}

export function invertMatrix(matrix: AffineMatrix): AffineMatrix {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    throw new AffineTransformError("Cannot invert singular LightBurn affine transform")
  }
  const a = matrix.d / determinant
  const b = -matrix.b / determinant
  const c = -matrix.c / determinant
  const d = matrix.a / determinant
  return {
    a,
    b,
    c,
    d,
    tx: -(a * matrix.tx + c * matrix.ty),
    ty: -(b * matrix.tx + d * matrix.ty),
  }
}

export function transformPoint(matrix: AffineMatrix, point: Point): Point {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.tx,
    y: matrix.b * point.x + matrix.d * point.y + matrix.ty,
  }
}

const NUMBER = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?"
const XFORM_PATTERN = new RegExp(`^\\s*(${NUMBER})\\s+(${NUMBER})\\s+(${NUMBER})\\s+(${NUMBER})\\s+(${NUMBER})\\s+(${NUMBER})\\s*$`)

export function parseXForm(value: string | undefined): AffineMatrix {
  if (value === undefined || value.trim() === "") return identityMatrix()
  const match = XFORM_PATTERN.exec(value)
  if (!match) throw new AffineTransformError(`Malformed <XForm>: ${JSON.stringify(value)}`)
  const numbers = match.slice(1).map(Number)
  if (numbers.some((number) => !Number.isFinite(number))) {
    throw new AffineTransformError(`Non-finite <XForm>: ${JSON.stringify(value)}`)
  }
  return {
    a: numbers[0]!, b: numbers[1]!, c: numbers[2]!,
    d: numbers[3]!, tx: numbers[4]!, ty: numbers[5]!,
  }
}
