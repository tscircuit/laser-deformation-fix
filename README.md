# LightBurn Tooling-Anchored Warp

`lightburn-lens-warp` learns and reapplies one global nonlinear deformation
stored in a pair of LightBurn projects. The four paths on the project's Tool
layer define the normalization frame, so projects with different board extents
retain the same corrected tooling coordinates.

The learned direction is:

```text
original geometry -> corrected/deformed geometry
```

The tool reproduces deformation already present in a corrected LightBurn file.
It does not infer physical lens error from a photograph or scan.

## Install and run

Install [Bun](https://bun.sh/), then:

```bash
bun install
bun run src/cli.ts --help
```

Build a Node-compatible executable with:

```bash
bun run build
./dist/cli.js --help
```

## Local UI

Start the browser interface with:

```bash
bun run start
```

Open `http://127.0.0.1:3000`. The first step learns and downloads a transform
from an original/corrected calibration pair. The second step applies the built-in
default matrix generated from the included alignment test circuit pair, a newly
generated transform, or an uploaded v2 transform JSON to a LightBurn project and
downloads the corrected project. Uploaded files remain local and temporary
working files are removed after each operation.

## Learn

```bash
bun run src/cli.ts learn \
  samples/alignment_test_circuit.lbrn2 \
  samples/alignment_test_circuit_corrected.lbrn2 \
  generated/alignment_transform.json
```

Paths are paired by `CutIndex` and layer-local order. When paired paths have
compatible raw vertex counts and open/closed topology, their vertices are used
directly as fitting correspondences. Incompatible paths are excluded from the
direct fit but remain part of final contour verification.

The bicubic uses normalized source X/Y and two 4 by 4 coefficient matrices for
absolute output X and Y. It is solved by SVD and rejected if the design matrix
does not have rank 16 or the direct vertex residual exceeds `0.0001 mm`.

The `lightburn-global-warp-v2` JSON records the source Tool bounds, normalized
source Tool templates, exact corrected Tool geometry, mirror flags, bicubic
coefficients, direct-fit statistics, and full-contour verification statistics.
Learning requires exactly one Tool cut setting containing four paths. Existing
transform files are not overwritten, and legacy v1 transforms must be relearned.

## Apply

```bash
bun run src/cli.ts apply \
  generated/alignment_transform.json \
  samples/rp2040.lbrn2 \
  generated/rp2040_transformed.lbrn2
```

Options:

```text
--segment-length 0.05
```

The input Tool paths are matched geometrically, independent of document order.
Their corrected geometry is copied exactly from the calibration transform.
Missing, ambiguous, incomplete, or mismatched Tool geometry is an error.

All other supported objects are normalized against the input Tool bounds,
warped, and emitted as explicit line-only paths. The default maximum generated
segment length is `0.05 mm`. Geometry outside the Tool rectangle is
extrapolated and reported in the command result.

Nested transforms and shared `VertID`/`PrimID` geometry are resolved before
nonlinear correction. Metadata, cut settings, grouping, and object ordering are
preserved where possible. Unsupported objects are an explicit error; convert
them to paths in LightBurn first. Stale thumbnails are removed.

## Verify

```bash
bun run src/cli.ts verify \
  generated/alignment_transform.json \
  samples/alignment_test_circuit.lbrn2 \
  samples/alignment_test_circuit_corrected.lbrn2 \
  --tolerance 0.01
```

Verification applies the transform in memory, pairs paths by `CutIndex` and
layer-local order, and requires every contour to remain within the symmetric
Hausdorff tolerance.

## Inspect

```bash
bun run src/cli.ts inspect project.lbrn2
```

`inspect` reports format, shape counts, usable vectors, path and primitive
counts, shared geometry references, mirror flags, unsupported types, warnings,
and approximate world-space bounds.

## Coordinates and Bézier handles

Geometry is evaluated in the coordinates stored in the project. `MirrorX` and
`MirrorY` identify that coordinate frame and are not applied as another
reflection. Learning rejects mismatched calibration mirror flags, and applying
rejects a project that does not match its transform.

For a LightBurn cubic primitive from vertex A to vertex B, A's `c0` is the first
control and B's `c1` is the second control.

`.lbrn2` has no complete public schema. This implementation supports packed
`VertList`, explicit line and cubic primitives, `LineOpen`/`LineClosed`, shared
geometry references, nested groups, and the known legacy `.lbrn` expanded V/P
representation. Keep an untouched project backup and inspect generated files in
LightBurn before sending them to a laser.

## Development

```bash
bun run typecheck
bun test
bun run lint
bun run build
```

The regression suite includes parser and geometry fixtures plus direct fitting,
tooling-template validation, exact RP2040 tooling placement, application, and
full contour verification.
