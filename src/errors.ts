export class LightBurnLensWarpError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = new.target.name
  }
}

export class XmlFormatError extends LightBurnLensWarpError {
  constructor(message: string) { super(message, "XML_FORMAT") }
}
export class GeometryParseError extends LightBurnLensWarpError {
  constructor(message: string) { super(message, "GEOMETRY_PARSE") }
}
export class GeometryReferenceError extends LightBurnLensWarpError {
  constructor(message: string) { super(message, "GEOMETRY_REFERENCE") }
}
export class AffineTransformError extends LightBurnLensWarpError {
  constructor(message: string) { super(message, "AFFINE_TRANSFORM") }
}
export class CalibrationError extends LightBurnLensWarpError {
  constructor(message: string) { super(message, "CALIBRATION") }
}
export class TopologyMismatchError extends LightBurnLensWarpError {
  constructor(message: string) { super(message, "TOPOLOGY_MISMATCH") }
}
export class TransformValidationError extends LightBurnLensWarpError {
  constructor(message: string) { super(message, "TRANSFORM_VALIDATION") }
}
export class OutputConflictError extends LightBurnLensWarpError {
  constructor(message: string) { super(message, "OUTPUT_CONFLICT") }
}
export class OutsideBoundsError extends LightBurnLensWarpError {
  constructor(message: string) { super(message, "OUTSIDE_BOUNDS") }
}
export class VerificationError extends LightBurnLensWarpError {
  constructor(message: string) { super(message, "VERIFICATION") }
}
