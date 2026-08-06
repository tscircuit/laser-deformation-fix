#!/usr/bin/env node
import { Command } from "commander"
import { applyCommand } from "./commands/apply.js"
import { inspectCommand } from "./commands/inspect.js"
import { learnCommand } from "./commands/learn.js"
import { verifyCommand } from "./commands/verify.js"
import { LightBurnLensWarpError } from "./errors.js"

function positiveNumber(value: string): number {
  const parsed = Number(value)
  if (!(parsed > 0) || !Number.isFinite(parsed)) throw new Error(`Expected a positive number, got ${value}`)
  return parsed
}

function printWarnings(warnings: readonly string[]): void {
  for (const warning of [...new Set(warnings)]) console.error(`warning: ${warning}`)
}

const program = new Command()
  .name("lightburn-lens-warp")
  .description("Learn and apply geometric lens pre-warp corrections to LightBurn projects")
  .showHelpAfterError()

program.command("inspect")
  .description("Inspect LightBurn vector geometry and project settings")
  .argument("<project>", "input .lbrn2 or .lbrn project")
  .action(async (project: string) => {
    const report = await inspectCommand(project)
    console.log(`Format: ${report.format}`)
    console.log(`Shape counts: ${Object.entries(report.shapeCounts).map(([type, count]) => `${type}=${count}`).join(", ") || "none"}`)
    console.log(`Usable vector shapes: ${report.usableVectorShapes}`)
    console.log(`Paths: ${report.paths}`)
    console.log(`Vertices: ${report.vertices}`)
    console.log(`Primitives: ${report.primitives}`)
    console.log(`Shared VertID references: ${report.sharedVertReferences}`)
    console.log(`Shared PrimID references: ${report.sharedPrimReferences}`)
    console.log(`MirrorX: ${report.mirrorX}`)
    console.log(`MirrorY: ${report.mirrorY}`)
    console.log(`Unsupported object types: ${Object.entries(report.unsupportedObjectTypes).map(([type, count]) => `${type}=${count}`).join(", ") || "none"}`)
    console.log(`Approximate world bounds: ${report.bounds?.join(" ") ?? "none"}`)
    printWarnings(report.warnings)
  })

program.command("learn")
  .description("Learn one global bicubic transform from an original/corrected pair")
  .argument("<original>", "original .lbrn2 or .lbrn project")
  .argument("<corrected>", "corrected .lbrn2 or .lbrn project")
  .argument("<transform>", "output transform JSON")
  .action(async (original: string, corrected: string, transform: string) => {
    const result = await learnCommand(original, corrected, transform)
    console.log(`Matched paths: ${result.matchedShapeCount}`)
    console.log(`Fitted correspondences: ${result.transform.fit.matchedPointCount}`)
    console.log(`Matrix rank: ${result.transform.fit.matrixRank}`)
    console.log(`RMS error (mm): ${result.transform.fit.rmsErrorMm}`)
    console.log(`Mean error (mm): ${result.transform.fit.meanErrorMm}`)
    console.log(`Max error (mm): ${result.transform.fit.maxErrorMm}`)
    console.log(`Verified paths: ${result.transform.verification.matchedPathCount}`)
    console.log(`Max symmetric Hausdorff distance (mm): ${result.transform.verification.maxSymmetricHausdorffMm}`)
    console.log(`Wrote transform: ${transform}`)
    printWarnings(result.warnings)
  })

program.command("apply")
  .description("Apply a tooling-anchored lens correction to a LightBurn project")
  .argument("<transform>")
  .argument("<input>")
  .argument("<output>")
  .option("--segment-length <mm>", "maximum generated line length", positiveNumber, 0.05)
  .action(async (
    transform: string,
    input: string,
    output: string,
    options: { segmentLength: number },
  ) => {
    const result = await applyCommand(transform, input, output, options)
    console.log(`Corrected shapes: ${result.correctedShapeCount}`)
    console.log(`Points outside transformation bounds: ${result.outsidePointCount}`)
    console.log(`Wrote project: ${output}`)
    printWarnings(result.warnings)
  })

program.command("verify")
  .description("Apply a transform in memory and compare every path with a reference")
  .argument("<transform>")
  .argument("<input>")
  .argument("<reference>")
  .option("--tolerance <mm>", "maximum symmetric Hausdorff distance", positiveNumber, 0.01)
  .action(async (
    transform: string,
    input: string,
    reference: string,
    options: { tolerance: number },
  ) => {
    const result = await verifyCommand(transform, input, reference, options)
    console.log(`Matched paths: ${result.matchedPathCount}`)
    console.log(`Max symmetric Hausdorff distance (mm): ${result.maxSymmetricHausdorffMm}`)
    console.log(`Tolerance (mm): ${result.toleranceMm}`)
  })

try {
  await program.parseAsync(process.argv)
} catch (error) {
  if (error instanceof LightBurnLensWarpError) console.error(`error [${error.code}]: ${error.message}`)
  else console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
