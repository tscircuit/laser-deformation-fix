# LightBurn Layer Warp

`lightburn-lens-warp` learns and reapplies the layer-aware deformation stored in a
pair of LightBurn projects. It is designed for projects where some cut layers
receive LightBurn's nonlinear deformation and the remaining layers receive only
a placement translation.

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

## Learn

```bash
bun run src/cli.ts learn \
  samples/led_test_V3.lbrn2 \
  samples/deformation_corrected_led_test_V3.lbrn2 \
  generated/led_test_V3_transform.json
```

Paths are paired by `CutIndex` and layer-local order. When paired paths have
compatible raw vertex counts and open/closed topology, their vertices are used
directly as fitting correspondences. Incompatible paths are excluded from the
direct fit but remain part of final contour verification.

Learning automatically separates layers into two classes:

- Layers whose target vertices contain no spatially varying deformation use the
  default translation rule.
- All other layers share one absolute-output tensor bicubic mapping.

The default translation is inferred only from the moved layers. For each
bicubic CutIndex, the learner compares the source and target layer extents, then
uses the median center shift across those layers. Vertex density, the bicubic
center distortion, and every unmoved layer are excluded from this placement
estimate.

The bicubic uses normalized source X/Y and two 4 by 4 coefficient matrices for
absolute output X and Y. It is solved by SVD and rejected if the design matrix
does not have rank 16 or the direct vertex residual exceeds `0.0001 mm`.

The `lightburn-layer-warp-v2` JSON records inferred source bounds, mirror flags,
the default translation, ordered `CutIndex` rules, coefficients, direct-fit
statistics, and full-contour verification statistics. Existing transform files
are not overwritten.

For the supplied V3 pair, the learner identifies CutIndexes `6`, `16`, and `30`
as bicubic, derives approximately `(83.8897, 60.3908) mm` for every other layer,
and fits 1,462 direct vertices.

## Apply

```bash
bun run src/cli.ts apply \
  generated/led_test_V3_transform.json \
  samples/led_test_V3.lbrn2 \
  generated/led_test_V3_generated_corrected.lbrn2
```

Options:

```text
--segment-length 0.05
--allow-outside
```

Translation-only layers retain their original object representation. Their
LightBurn transforms are translated in world coordinates, including for text,
images, and unknown objects.

Objects on bicubic layers are flattened in world coordinates and emitted as
explicit line-only paths. Paths, rectangles, ellipses, and polygons are
supported. An unsupported object assigned to a bicubic layer is an explicit
error; convert it to paths in LightBurn first.

The default maximum generated segment length is `0.05 mm`. Geometry outside the
inferred calibration bounds is an error unless `--allow-outside` is supplied.
With the override, the bicubic polynomial is extrapolated.

Nested transforms and shared `VertID`/`PrimID` geometry are resolved before
nonlinear correction. Metadata, cut settings, grouping, unsupported objects on
translation layers, and object ordering are preserved where possible. Stale
thumbnails are removed.

## Verify

```bash
bun run src/cli.ts verify \
  generated/led_test_V3_transform.json \
  samples/led_test_V3.lbrn2 \
  samples/deformation_corrected_led_test_V3.lbrn2 \
  --tolerance 0.01
```

Verification applies the transform in memory. Bicubic layers are paired with
the corrected reference by `CutIndex` and layer-local order and must remain
within the symmetric Hausdorff tolerance. Translation-only layers are validated
against the transform's derived placement instead of the corrected reference,
because those layers may not have been moved consistently in the calibration
file.

The supplied V3 files verify all 90 paths at approximately `0.00535 mm`.

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
automatic classification, application, and full contour verification against
the supplied V3 projects.
