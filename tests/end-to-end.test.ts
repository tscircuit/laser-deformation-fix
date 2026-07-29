import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCorrespondences } from "../src/calibration/correspondences.js";
import {
  applyCommand,
  applyTransformToDocument,
} from "../src/commands/apply.js";
import { learnCommand } from "../src/commands/learn.js";
import { verifyCommand } from "../src/commands/verify.js";
import type {
  CoefficientMatrix4,
  GlobalWarpTransform,
  ResolvedPath,
} from "../src/types.js";
import {
  collectShapeRecords,
  GeometryResolver,
} from "../src/xml/geometry-resolver.js";
import { extractToolingLayer } from "../src/calibration/tooling.js";
import { parseLightBurn } from "../src/xml/parse-lightburn.js";

const temporaryDirectories: string[] = [];
afterEach(async () =>
  Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  ),
);

const zeros = (): CoefficientMatrix4 => [
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
];

function toolingPath(points: [[number, number], [number, number]]): ResolvedPath {
  return {
    vertices: points.map(([x, y]) => ({ x, y })),
    primitives: [{ kind: "line", startIndex: 0, endIndex: 1 }],
    closed: false,
  };
}

function testTransform(): GlobalWarpTransform {
  const xCoefficients = zeros();
  const yCoefficients = zeros();
  xCoefficients[1][0] = 10;
  yCoefficients[0][1] = 10;
  return {
    format: "lightburn-global-warp-v2",
    sourceBoundsMm: [0, 0, 10, 10],
    coordinateFrame: { mirrorX: false, mirrorY: false },
    tooling: {
      cutIndex: "30",
      paths: [
        {
          sourceNormalized: toolingPath([[0, 0], [0.01, 0]]),
          targetWorld: toolingPath([[0, 0], [0.1, 0]]),
        },
        {
          sourceNormalized: toolingPath([[1, 0], [1, 0.01]]),
          targetWorld: toolingPath([[10, 0], [10, 0.1]]),
        },
        {
          sourceNormalized: toolingPath([[1, 1], [0.99, 1]]),
          targetWorld: toolingPath([[10, 10], [9.9, 10]]),
        },
        {
          sourceNormalized: toolingPath([[0, 1], [0, 0.99]]),
          targetWorld: toolingPath([[0, 10], [0, 9.9]]),
        },
      ],
    },
    xCoefficients,
    yCoefficients,
    fit: {
      matchedPathCount: 1,
      matchedPointCount: 16,
      excludedPathCount: 0,
      matrixRank: 16,
      rmsErrorMm: 0,
      meanErrorMm: 0,
      maxErrorMm: 0,
    },
    verification: {
      matchedPathCount: 1,
      maxSymmetricHausdorffMm: 0,
      toleranceMm: 0.01,
    },
  };
}

function project(shapes: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<LightBurnProject FormatVersion="1" MirrorX="False" MirrorY="False">` +
    `<CutSetting type="Tool"><index Value="30"/><name Value="T1"/></CutSetting>` +
    `${shapes}` +
    `<Shape Type="Path" CutIndex="30"><VertList>V0 0V0.1 0</VertList><PrimList>LineOpen</PrimList></Shape>` +
    `<Shape Type="Path" CutIndex="30"><VertList>V10 0V10 0.1</VertList><PrimList>LineOpen</PrimList></Shape>` +
    `<Shape Type="Path" CutIndex="30"><VertList>V10 10V9.9 10</VertList><PrimList>LineOpen</PrimList></Shape>` +
    `<Shape Type="Path" CutIndex="30"><VertList>V0 10V0 9.9</VertList><PrimList>LineOpen</PrimList></Shape>` +
    `</LightBurnProject>`
  );
}

describe("global learning and application", () => {
  test("fits the alignment pair once and applies it to every LED layer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "global-warp-"));
    temporaryDirectories.push(directory);
    const originalPath = join(
      import.meta.dir,
      "..",
      "samples",
      "alignment_test_circuit.lbrn2",
    );
    const correctedPath = join(
      import.meta.dir,
      "..",
      "samples",
      "alignment_test_circuit_corrected.lbrn2",
    );
    const ledPath = join(import.meta.dir, "..", "samples", "led_test_V3.lbrn2");
    const transformPath = join(directory, "transform.json");
    const outputPath = join(directory, "output.lbrn2");
    const rp2040Path = join(import.meta.dir, "..", "samples", "rp2040.lbrn2");
    const rp2040OutputPath = join(directory, "rp2040-output.lbrn2");
    const learned = await learnCommand(
      originalPath,
      correctedPath,
      transformPath,
    );
    expect(learned.transform.fit.matchedPointCount).toBe(2512);
    expect(learned.transform.fit.excludedPathCount).toBe(0);
    expect(learned.transform.fit.matrixRank).toBe(16);
    expect(learned.transform.fit.maxErrorMm).toBeLessThan(0.0001);
    expect(learned.transform.verification.matchedPathCount).toBe(48);
    expect(
      learned.transform.verification.maxSymmetricHausdorffMm,
    ).toBeLessThanOrEqual(0.01);

    const applied = await applyCommand(transformPath, ledPath, outputPath);
    expect(applied.correctedShapeCount).toBe(90);
    expect(applied.outsidePointCount).toBeGreaterThan(0);
    const output = parseLightBurn(
      await readFile(outputPath, "utf8"),
      outputPath,
    );
    const outputShapes = collectShapeRecords(output.root);
    expect(
      outputShapes.filter((shape) => shape.shapeType === "Path"),
    ).toHaveLength(90);
    const led = parseLightBurn(await readFile(ledPath, "utf8"), ledPath);
    const inputCutIndexes = collectShapeRecords(led.root)
      .filter((shape) => shape.shapeType === "Path")
      .map((shape) => shape.element.attributes.CutIndex);
    const outputCutIndexes = outputShapes
      .filter((shape) => shape.shapeType === "Path")
      .map((shape) => shape.element.attributes.CutIndex);
    expect(outputCutIndexes).toEqual(inputCutIndexes);

    const rp2040Applied = await applyCommand(
      transformPath,
      rp2040Path,
      rp2040OutputPath,
    );
    const rp2040Input = parseLightBurn(
      await readFile(rp2040Path, "utf8"),
      rp2040Path,
    );
    const rp2040ShapeCount = collectShapeRecords(rp2040Input.root)
      .filter((shape) => shape.shapeType !== "Group")
      .length;
    expect(rp2040Applied.correctedShapeCount).toBe(rp2040ShapeCount);
    expect(rp2040Applied.outsidePointCount).toBeGreaterThan(0);
    const rp2040Output = parseLightBurn(
      await readFile(rp2040OutputPath, "utf8"),
      rp2040OutputPath,
    );
    const corrected = parseLightBurn(
      await readFile(correctedPath, "utf8"),
      correctedPath,
    );
    const actualTooling = extractToolingLayer(rp2040Output, "transform");
    const expectedTooling = extractToolingLayer(corrected, "transform");
    expect(expectedTooling.bounds).toEqual([
      49.559013,
      41.727432,
      141.56178,
      105.43775,
    ]);
    expect(actualTooling.bounds).toEqual(expectedTooling.bounds);
    const geometrySignatures = (
      paths: typeof actualTooling.paths,
    ): string[] => paths
      .map((path) => JSON.stringify(path.worldPath))
      .sort();
    expect(geometrySignatures(actualTooling.paths))
      .toEqual(geometrySignatures(expectedTooling.paths));

    const verified = await verifyCommand(
      transformPath,
      originalPath,
      correctedPath,
    );
    expect(verified.matchedPathCount).toBe(48);
    expect(verified.maxSymmetricHausdorffMm).toBeLessThanOrEqual(0.01);
  });

  test("builds every alignment correspondence without layer filtering", async () => {
    const originalPath = join(
      import.meta.dir,
      "..",
      "samples",
      "alignment_test_circuit.lbrn2",
    );
    const correctedPath = join(
      import.meta.dir,
      "..",
      "samples",
      "alignment_test_circuit_corrected.lbrn2",
    );
    const [original, corrected] = await Promise.all([
      readFile(originalPath, "utf8").then((xml) =>
        parseLightBurn(xml, originalPath),
      ),
      readFile(correctedPath, "utf8").then((xml) =>
        parseLightBurn(xml, correctedPath),
      ),
    ]);
    const result = buildCorrespondences(original, corrected);
    expect(result.matchedShapeCount).toBe(48);
    expect(result.excludedPathCount).toBe(0);
    expect(result.correspondences).toHaveLength(2512);
  });
});

describe("global application", () => {
  test("uses the same matrix for every CutIndex", () => {
    const input = parseLightBurn(
      project(`
      <Shape Type="Path" CutIndex="0"><VertList>V0 0V10 10</VertList><PrimList>LineOpen</PrimList></Shape>
      <Shape Type="Path" CutIndex="6"><VertList>V0 10V10 0</VertList><PrimList>LineOpen</PrimList></Shape>
    `),
      "global.lbrn2",
    );
    const result = applyTransformToDocument(input, testTransform(), {
      segmentLength: 20,
    });
    const shapes = collectShapeRecords(result.document.root);
    const resolver = new GeometryResolver(shapes);
    expect(result.correctedShapeCount).toBe(6);
    expect(result.outsidePointCount).toBe(0);
    expect(resolver.resolve(shapes[0]!).vertices).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ]);
    expect(resolver.resolve(shapes[1]!).vertices).toEqual([
      { x: 0, y: 10 },
      { x: 10, y: 0 },
    ]);
  });

  test("fails on unsupported shapes", () => {
    const input = parseLightBurn(
      project(
        '<Shape Type="Text" CutIndex="6" Str="hello"><XForm>1 0 0 1 5 5</XForm></Shape>',
      ),
      "text.lbrn2",
    );
    expect(() => applyTransformToDocument(input, testTransform())).toThrow(
      "Unsupported Text",
    );
  });

  test("materializes paths as independently resolvable line geometry", () => {
    const input = parseLightBurn(
      project(
        '<Shape Type="Path" CutIndex="6"><VertList>V0 0V10 10</VertList><PrimList>LineOpen</PrimList></Shape>',
      ),
      "nonlinear.lbrn2",
    );
    const result = applyTransformToDocument(input, testTransform(), {
      segmentLength: 1,
    });
    const shapes = collectShapeRecords(result.document.root);
    const path = new GeometryResolver(shapes).resolve(shapes[0]!);
    expect(path.vertices.length).toBeGreaterThan(2);
    expect(
      path.primitives.every((primitive) => primitive.kind === "line"),
    ).toBe(true);
  });

  test("rejects missing, ambiguous, incomplete, and mismatched tooling", () => {
    const valid = project(
      '<Shape Type="Path" CutIndex="6"><VertList>V1 1V2 2</VertList><PrimList>LineOpen</PrimList></Shape>',
    );
    const setting = '<CutSetting type="Tool"><index Value="30"/><name Value="T1"/></CutSetting>';
    const lastToolPath = '<Shape Type="Path" CutIndex="30"><VertList>V0 10V0 9.9</VertList><PrimList>LineOpen</PrimList></Shape>';
    expect(() => applyTransformToDocument(
      parseLightBurn(valid.replace(setting, ""), "missing-tool.lbrn2"),
      testTransform(),
    )).toThrow("Expected exactly one Tool CutSetting");
    expect(() => applyTransformToDocument(
      parseLightBurn(valid.replace(setting, setting + setting), "ambiguous-tool.lbrn2"),
      testTransform(),
    )).toThrow("found 2");
    expect(() => applyTransformToDocument(
      parseLightBurn(valid.replace(lastToolPath, ""), "incomplete-tool.lbrn2"),
      testTransform(),
    )).toThrow("exactly four Path shapes");
    expect(() => applyTransformToDocument(
      parseLightBurn(valid.replace("V0 0V0.1 0", "V0 0V0.2 0"), "mismatched-tool.lbrn2"),
      testTransform(),
    )).toThrow("does not match the calibration tooling template");
  });
});
