import assert from "node:assert/strict"
import { test } from "bun:test"
import { flattenCubicBezier, subdivideLine } from "../src/geometry/subdivision.js"
import { pathToWorldContours } from "../src/geometry/paths.js"
import type { AffineMatrix, Point, ResolvedPath } from "../src/types.js"

type Cubic = [Point, Point, Point, Point]

const point = (x: number, y: number): Point => ({ x, y })

// Independent Bernstein evaluation, rather than the production subdivision.
function evaluate(curve: Cubic, t: number): Point {
  const [a, b, c, d] = curve
  const s = 1 - t
  return point(
    s ** 3 * a.x + 3 * s * s * t * b.x + 3 * s * t * t * c.x + t ** 3 * d.x,
    s ** 3 * a.y + 3 * s * s * t * b.y + 3 * s * t * t * c.y + t ** 3 * d.y,
  )
}

function distanceToPolyline(p: Point, points: Point[]): number {
  let minimum = Infinity
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    const dx = b.x - a.x
    const dy = b.y - a.y
    const squaredLength = dx * dx + dy * dy
    const t = squaredLength === 0
      ? 0
      : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / squaredLength))
    minimum = Math.min(minimum, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy))
  }
  return minimum
}

function assertApproximation(curve: Cubic, points: Point[], scale: number): void {
  assert.deepEqual(points[0], curve[0])
  assert.deepEqual(points.at(-1), curve[3])
  const slack = scale * 1e-10
  for (let i = 1; i < points.length; i++) {
    assert.ok(Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y) <= 0.05 * scale + slack)
  }
  // Non-dyadic samples do not just land on subdivision vertices.
  for (let i = 0; i <= 257; i++) {
    const deviation = distanceToPolyline(evaluate(curve, i / 257), points)
    assert.ok(deviation <= 0.001 * scale + slack, "sample " + i + ": deviation " + deviation)
  }
}

const shapes: [string, Cubic][] = [
  ["forward overshoot", [point(0, 0), point(1, 0), point(1, 0), point(0.01, 0)]],
  ["backward overshoot", [point(0, 0), point(-1, 0), point(-1, 0), point(0.01, 0)]],
  ["vertical overshoot", [point(0, 0), point(0, 1), point(0, 1), point(0, 0.01)]],
  ["diagonal overshoot", [point(0, 0), point(1, 1), point(1, 1), point(0.01, 0.01)]],
  ["reversed endpoints", [point(0.01, 0), point(1, 0), point(1, 0), point(0, 0)]],
  ["opposing handles", [point(0, 0), point(1, 0), point(-1, 0), point(0.01, 0)]],
]

for (const scale of [0.0001, 1, 1000]) {
  for (const [name, shape] of shapes) {
    test("preserves " + name + " at scale " + scale, () => {
      const curve = shape.map((p) => point(p.x * scale, p.y * scale)) as Cubic
      const points = flattenCubicBezier(...curve, {
        maxSegmentLength: 0.05 * scale,
        flatnessTolerance: 0.001 * scale,
      })
      assertApproximation(curve, points, scale)
    })
  }
}

test("retains the analytic midpoint of a collinear return", () => {
  const curve = shapes[0]![1]
  const points = flattenCubicBezier(...curve, { maxSegmentLength: 0.05, flatnessTolerance: 0.001 })
  assert.ok(points.some((p) => p.x === 0.75125 && p.y === 0))
})

test("keeps a short monotone cubic as its chord", () => {
  const curve: Cubic = [point(0, 0), point(0.003, 0), point(0.007, 0), point(0.01, 0)]
  assert.deepEqual(flattenCubicBezier(...curve, {
    maxSegmentLength: 0.05, flatnessTolerance: 0.001,
  }), [curve[0], curve[3]])
})

test("keeps controls at the chord endpoints flat", () => {
  const curve: Cubic = [point(0, 0), point(0, 0), point(0.01, 0), point(0.01, 0)]
  assert.deepEqual(flattenCubicBezier(...curve, {
    maxSegmentLength: 0.05, flatnessTolerance: 0.001,
  }), [curve[0], curve[3]])
})

test("still respects the segment length for a long monotone cubic", () => {
  const curve: Cubic = [point(0, 0), point(0.3, 0), point(0.7, 0), point(1, 0)]
  assertApproximation(curve, flattenCubicBezier(...curve, {
    maxSegmentLength: 0.05, flatnessTolerance: 0.001,
  }), 1)
})

test("still approximates an ordinary arch", () => {
  const curve: Cubic = [point(0, 0), point(0, 2), point(2, 2), point(2, 0)]
  assertApproximation(curve, flattenCubicBezier(...curve, {
    maxSegmentLength: 0.05, flatnessTolerance: 0.001,
  }), 1)
})

test("preserves a curve with coincident endpoints", () => {
  const curve: Cubic = [point(0, 0), point(1, 1), point(-1, 1), point(0, 0)]
  assertApproximation(curve, flattenCubicBezier(...curve, {
    maxSegmentLength: 0.05, flatnessTolerance: 0.001,
  }), 1)
})

test("keeps a degenerate point curve unchanged", () => {
  const p = point(2, 3)
  assert.deepEqual(flattenCubicBezier(p, p, p, p, {
    maxSegmentLength: 0.05, flatnessTolerance: 0.001,
  }), [p, p])
})

test("does not force subdivision for an overshoot within flatness tolerance", () => {
  const curve: Cubic = [point(0, 0), point(0.0101, 0), point(0.0101, 0), point(0.01, 0)]
  assert.deepEqual(flattenCubicBezier(...curve, {
    maxSegmentLength: 0.05, flatnessTolerance: 0.001,
  }), [curve[0], curve[3]])
})

test("does not change line subdivision", () => {
  assert.deepEqual(subdivideLine(point(0, 0), point(0.1, 0), 0.05), [
    point(0, 0), point(0.05, 0), point(0.1, 0),
  ])
})

test("preserves the return through the real world-contour caller", () => {
  const curve = shapes[0]![1]
  const path: ResolvedPath = {
    vertices: [{ ...curve[0], c0: curve[1] }, { ...curve[3], c1: curve[2] }],
    primitives: [{ kind: "cubic-bezier", startIndex: 0, endIndex: 1 }],
    closed: false,
  }
  const original = structuredClone(path)
  const matrix: AffineMatrix = { a: 0, b: 2, c: -2, d: 0, tx: 3, ty: -4 }
  const contours = pathToWorldContours(path, matrix, {
    maxSegmentLength: 0.1, flatnessTolerance: 0.002,
  })
  const expected = curve.map((p) => point(3 - 2 * p.y, -4 + 2 * p.x)) as Cubic
  assert.equal(contours.length, 1)
  assert.equal(contours[0]!.closed, false)
  assertApproximation(expected, contours[0]!.points, 2)
  assert.deepEqual(path, original)
})
