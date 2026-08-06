import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { POST } from "../app/api/apply/route"

describe("hosted apply API", () => {
  test("applies the built-in default transformation matrix", async () => {
    const inputName = "alignment_test_circuit.lbrn2"
    const input = new File(
      [await readFile(join(import.meta.dir, "..", "samples", inputName))],
      inputName,
      { type: "application/xml" },
    )
    const form = new FormData()
    form.set("transformSource", "default")
    form.set("input", input)

    const response = await POST(new Request("http://localhost/api/apply", {
      method: "POST",
      body: form,
    }))

    expect(response.status).toBe(200)
    expect(response.headers.get("X-Corrected-Shapes")).toBe("48")
    expect(response.headers.get("X-Output-File"))
      .toBe("alignment_test_circuit_transformed.lbrn2")
    expect((await response.text()).startsWith("<?xml")).toBe(true)
  })
})
