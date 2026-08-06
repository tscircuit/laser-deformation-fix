"use client"

import { FormEvent, useEffect, useState } from "react"

interface LearnResponse {
  transform: Record<string, unknown> & { format: string }
  transformFileName: string
  summary: {
    matchedPaths: number
    fittedPoints: number
    matrixRank: number
    rmsErrorMm: number
    verificationErrorMm: number
  }
  warnings: string[]
}

type TransformSource = "default" | "generated" | "uploaded"

async function responseError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string }
    return body.error ?? `Request failed (${response.status})`
  } catch {
    return `Request failed (${response.status})`
  }
}

function FileField({
  id,
  label,
  help,
  accept,
  optional = false,
  onChange,
}: {
  id: string
  label: string
  help: string
  accept: string
  optional?: boolean
  onChange(file: File | undefined): void
}) {
  const [name, setName] = useState("")
  return (
    <label className={`file-field${optional ? " optional-field" : ""}`}>
      <span className="file-label">{label}{optional && <em> optional</em>}</span>
      <span className="file-help">{help}</span>
      <input
        id={id}
        type="file"
        accept={accept}
        required={!optional}
        onChange={(event) => {
          const file = event.target.files?.[0]
          setName(file?.name ?? "")
          onChange(file)
        }}
      />
      <span className="file-choice">
        {name || (optional ? "Choose existing matrix" : "Choose LightBurn file")}
      </span>
    </label>
  )
}

export default function Home() {
  const [original, setOriginal] = useState<File>()
  const [corrected, setCorrected] = useState<File>()
  const [input, setInput] = useState<File>()
  const [selectedTransform, setSelectedTransform] = useState<File>()
  const [generatedTransform, setGeneratedTransform] = useState<File>()
  const [transformSource, setTransformSource] = useState<TransformSource>("default")
  const [learnData, setLearnData] = useState<LearnResponse>()
  const [learnStatus, setLearnStatus] = useState("")
  const [applyStatus, setApplyStatus] = useState("")
  const [learning, setLearning] = useState(false)
  const [applying, setApplying] = useState(false)
  const [matrixUrl, setMatrixUrl] = useState("")
  const [output, setOutput] = useState<{ url: string; name: string; shapes: string }>()

  useEffect(() => () => {
    if (matrixUrl) URL.revokeObjectURL(matrixUrl)
    if (output?.url) URL.revokeObjectURL(output.url)
  }, [matrixUrl, output])

  async function learn(event: FormEvent) {
    event.preventDefault()
    if (!original || !corrected) return
    setLearning(true)
    setLearnStatus("")
    setLearnData(undefined)
    try {
      const form = new FormData()
      form.set("original", original)
      form.set("corrected", corrected)
      const response = await fetch("/api/learn", { method: "POST", body: form })
      if (!response.ok) throw new Error(await responseError(response))
      const data = await response.json() as LearnResponse
      const transform = new File(
        [`${JSON.stringify(data.transform, null, 2)}\n`],
        data.transformFileName,
        { type: "application/json" },
      )
      if (matrixUrl) URL.revokeObjectURL(matrixUrl)
      const url = URL.createObjectURL(transform)
      setGeneratedTransform(transform)
      setTransformSource("generated")
      setMatrixUrl(url)
      setLearnData(data)
      setLearnStatus(data.warnings.length
        ? `Ready with ${data.warnings.length} parser warning(s).`
        : "Ready to apply.")
    } catch (error) {
      setGeneratedTransform(undefined)
      setLearnStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setLearning(false)
    }
  }

  async function apply(event: FormEvent) {
    event.preventDefault()
    if (!input) return
    const transform = transformSource === "uploaded"
      ? selectedTransform
      : transformSource === "generated" ? generatedTransform : undefined
    if (transformSource !== "default" && !transform) {
      setApplyStatus(transformSource === "generated"
        ? "Generate a matrix above before selecting the generated matrix."
        : "Choose a transformation JSON before selecting the uploaded matrix.")
      return
    }
    setApplying(true)
    setApplyStatus("")
    setOutput(undefined)
    try {
      const form = new FormData()
      form.set("transformSource", transformSource)
      if (transform) form.set("transform", transform)
      form.set("input", input)
      const response = await fetch("/api/apply?matrix-source=v2", { method: "POST", body: form })
      if (!response.ok) throw new Error(await responseError(response))
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const name = response.headers.get("X-Output-File") ?? "project_transformed.lbrn2"
      const shapes = response.headers.get("X-Corrected-Shapes") ?? "0"
      const outside = Number(response.headers.get("X-Outside-Points") ?? 0)
      setOutput({ url, name, shapes })
      setApplyStatus(outside > 0
        ? `${outside.toLocaleString()} generated points were extrapolated beyond the tooling frame.`
        : "All generated points were inside the tooling frame.")
    } catch (error) {
      setApplyStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="page-shell">
      <header className="hero">
        <div className="brand-row"><span className="hosted-badge">Public web app</span></div>
        <div className="hero-copy">
          <div>
            <p className="eyebrow">LightBurn alignment utility</p>
            <h1>Calibrate once.<br />Apply anywhere.</h1>
          </div>
          <p className="lede">
            Build a tooling-anchored transformation matrix from a known pair,
            then apply it to any compatible LightBurn project.
          </p>
        </div>
      </header>

      <main className="workflow" aria-label="Transformation workflow">
        <section className="step-card" aria-labelledby="learn-title">
          <div className="step-heading">
            <span className="step-number">01</span>
            <div><p className="step-kicker">Calibration</p><h2 id="learn-title">Generate matrix</h2></div>
          </div>
          <form onSubmit={learn}>
            <FileField id="original-file" label="Original project" help="Uncorrected calibration geometry" accept=".lbrn,.lbrn2" onChange={setOriginal} />
            <FileField id="corrected-file" label="Corrected project" help="Aligned version of the same project" accept=".lbrn,.lbrn2" onChange={setCorrected} />
            <button className="primary-button" type="submit" disabled={learning}>
              <span>{learning ? "Fitting matrix…" : "Generate transformation"}</span><span aria-hidden="true">→</span>
            </button>
          </form>
          {learnData && (
            <div className="result-panel">
              <div className="result-title-row"><div><p className="result-label">Matrix ready</p><p className="result-value">{learnData.summary.matchedPaths} matched paths · rank {learnData.summary.matrixRank}</p></div><span className="success-dot" /></div>
              <dl className="metrics">
                <div><dt>Fit points</dt><dd>{learnData.summary.fittedPoints.toLocaleString()}</dd></div>
                <div><dt>RMS error</dt><dd>{learnData.summary.rmsErrorMm.toFixed(6)} mm</dd></div>
                <div><dt>Verify</dt><dd>{learnData.summary.verificationErrorMm.toFixed(6)} mm</dd></div>
              </dl>
              <a className="download-link" href={matrixUrl} download={learnData.transformFileName}>Download transform JSON</a>
            </div>
          )}
          <p className={`status${learnData ? "" : " error"}`} role="status" aria-live="polite">{learnStatus}</p>
        </section>

        <section className="step-card" aria-labelledby="apply-title">
          <div className="step-heading">
            <span className="step-number">02</span>
            <div><p className="step-kicker">Production</p><h2 id="apply-title">Transform a project</h2></div>
          </div>
          <form onSubmit={apply}>
            <FileField id="input-file" label="LightBurn project" help="The circuit or artwork to correct" accept=".lbrn,.lbrn2" onChange={setInput} />
            <fieldset className="matrix-options">
              <legend>Transformation matrix</legend>
              <label className={`matrix-option${transformSource === "default" ? " selected" : ""}`}>
                <input type="radio" name="transform-source" value="default" checked={transformSource === "default"} onChange={() => setTransformSource("default")} />
                <span><strong>Default transformation matrix</strong><small>alignment_test_circuit.lbrn2 → alignment_test_circuit_corrected.lbrn2</small></span>
              </label>
              <label className={`matrix-option${transformSource === "generated" ? " selected" : ""}${generatedTransform ? "" : " unavailable"}`}>
                <input type="radio" name="transform-source" value="generated" checked={transformSource === "generated"} disabled={!generatedTransform} onChange={() => setTransformSource("generated")} />
                <span><strong>Matrix generated above</strong><small>{generatedTransform ? generatedTransform.name : "Generate a matrix in step 01 first"}</small></span>
              </label>
              <label className={`matrix-option${transformSource === "uploaded" ? " selected" : ""}`}>
                <input type="radio" name="transform-source" value="uploaded" checked={transformSource === "uploaded"} onChange={() => setTransformSource("uploaded")} />
                <span><strong>Upload transformation JSON</strong><small>Use another saved v2 transformation</small></span>
              </label>
            </fieldset>
            {transformSource === "uploaded" && (
              <FileField id="transform-file" label="Transformation JSON" help="Choose a saved transformation matrix" accept=".json,application/json" onChange={(file) => {
                setSelectedTransform(file)
                if (file) setTransformSource("uploaded")
              }} />
            )}
            <button className="primary-button accent-button" type="submit" disabled={applying}>
              <span>{applying ? "Transforming project…" : "Apply transformation"}</span><span aria-hidden="true">→</span>
            </button>
          </form>
          {output && (
            <div className="result-panel">
              <div className="result-title-row"><div><p className="result-label">Project ready</p><p className="result-value">{output.shapes} shapes corrected</p></div><span className="success-dot" /></div>
              <a className="download-link" href={output.url} download={output.name}>Download transformed project</a>
            </div>
          )}
          <p className={`status${output ? "" : " error"}`} role="status" aria-live="polite">{applyStatus}</p>
        </section>
      </main>
      <footer className="footer-note">Files are processed only for each operation and are not kept by this app. Keep an untouched backup and inspect generated files in LightBurn before sending them to a laser.</footer>
    </div>
  )
}
