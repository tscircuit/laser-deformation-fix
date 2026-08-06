import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { handleRequest } from "../src/server.js"

const samples = join(import.meta.dir, "..", "samples")

async function sampleFile(name: string): Promise<File> {
  return new File(
    [await readFile(join(samples, name))],
    name,
    { type: "application/xml" },
  )
}

describe("local UI server", () => {
  test("serves the transformation workflow", async () => {
    const response = await handleRequest(new Request("http://localhost/"))
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toContain("text/html")
    expect(await response.text()).toContain("Generate matrix")
  })

  test("learns a transform and applies it through the API", async () => {
    const learnForm = new FormData()
    learnForm.set(
      "original",
      await sampleFile("alignment_test_circuit.lbrn2"),
    )
    learnForm.set(
      "corrected",
      await sampleFile("alignment_test_circuit_corrected.lbrn2"),
    )
    const learnedResponse = await handleRequest(new Request(
      "http://localhost/api/learn",
      { method: "POST", body: learnForm },
    ))
    expect(learnedResponse.status).toBe(200)
    const learned = await learnedResponse.json() as {
      transform: { format: string }
      summary: { matrixRank: number; matchedPaths: number }
    }
    expect(learned.transform.format).toBe("lightburn-global-warp-v2")
    expect(learned.summary.matrixRank).toBe(16)
    expect(learned.summary.matchedPaths).toBe(48)

    const applyForm = new FormData()
    applyForm.set("transform", new File(
      [`${JSON.stringify(learned.transform, null, 2)}\n`],
      "alignment_transform.json",
      { type: "application/json" },
    ))
    applyForm.set(
      "input",
      await sampleFile("alignment_test_circuit.lbrn2"),
    )
    const appliedResponse = await handleRequest(new Request(
      "http://localhost/api/apply",
      { method: "POST", body: applyForm },
    ))
    expect(appliedResponse.status).toBe(200)
    expect(appliedResponse.headers.get("X-Corrected-Shapes")).toBe("48")
    expect(appliedResponse.headers.get("X-Output-File"))
      .toBe("alignment_test_circuit_transformed.lbrn2")
    expect((await appliedResponse.text()).startsWith("<?xml")).toBe(true)
  })

  test("returns useful upload errors", async () => {
    const response = await handleRequest(new Request(
      "http://localhost/api/learn",
      { method: "POST", body: new FormData() },
    ))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "Missing original file",
      code: "UPLOAD",
    })
  })
})
