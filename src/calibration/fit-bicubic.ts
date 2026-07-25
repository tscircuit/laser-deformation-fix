import { Matrix, SingularValueDecomposition } from "ml-matrix"
import { CalibrationError } from "../errors.js"
import type {
  CalibrationCorrespondence,
  CoefficientMatrix4,
} from "../types.js"
import { bicubicBasis, validateBounds } from "./transform.js"

export interface BicubicFit {
  xCoefficients: CoefficientMatrix4
  yCoefficients: CoefficientMatrix4
  matrixRank: number
  rmsErrorMm: number
  meanErrorMm: number
  maxErrorMm: number
}

function coefficientMatrix(values: readonly number[]): CoefficientMatrix4 {
  return [
    [values[0]!, values[1]!, values[2]!, values[3]!],
    [values[4]!, values[5]!, values[6]!, values[7]!],
    [values[8]!, values[9]!, values[10]!, values[11]!],
    [values[12]!, values[13]!, values[14]!, values[15]!],
  ]
}

export function fitBicubic(
  correspondences: readonly CalibrationCorrespondence[],
  bounds: [number, number, number, number],
): BicubicFit {
  validateBounds(bounds)
  if (correspondences.length < 16) {
    throw new CalibrationError(
      `Insufficient bicubic calibration correspondences: need at least 16, got ${correspondences.length}`,
    )
  }
  const design = new Matrix(correspondences.map((item) => bicubicBasis(item.source, bounds)))
  const svd = new SingularValueDecomposition(design, { autoTranspose: true })
  const singularValues = svd.diagonal
  const maximum = Math.max(...singularValues)
  const tolerance = Number.EPSILON * Math.max(design.rows, design.columns) * maximum
  const rank = singularValues.filter((value) => value > tolerance).length
  if (rank < 16) {
    throw new CalibrationError(
      `Rank-deficient bicubic calibration geometry: matrix rank ${rank}, expected 16`,
    )
  }
  const solvedX = svd.solve(
    Matrix.columnVector(correspondences.map((item) => item.target.x)),
  ).getColumn(0)
  const solvedY = svd.solve(
    Matrix.columnVector(correspondences.map((item) => item.target.y)),
  ).getColumn(0)
  const errors = correspondences.map((item, rowIndex) => {
    let predictedX = 0
    let predictedY = 0
    for (let index = 0; index < 16; index++) {
      predictedX += design.get(rowIndex, index) * solvedX[index]!
      predictedY += design.get(rowIndex, index) * solvedY[index]!
    }
    return Math.hypot(predictedX - item.target.x, predictedY - item.target.y)
  })
  const mean = errors.reduce((sum, error) => sum + error, 0) / errors.length
  const rms = Math.sqrt(errors.reduce((sum, error) => sum + error ** 2, 0) / errors.length)
  return {
    xCoefficients: coefficientMatrix(solvedX),
    yCoefficients: coefficientMatrix(solvedY),
    matrixRank: rank,
    rmsErrorMm: rms,
    meanErrorMm: mean,
    maxErrorMm: Math.max(...errors),
  }
}
