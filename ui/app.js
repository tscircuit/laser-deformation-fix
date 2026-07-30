const learnForm = document.querySelector("#learn-form")
const applyForm = document.querySelector("#apply-form")
const learnButton = document.querySelector("#learn-button")
const applyButton = document.querySelector("#apply-button")
const learnStatus = document.querySelector("#learn-status")
const applyStatus = document.querySelector("#apply-status")
const learnResult = document.querySelector("#learn-result")
const applyResult = document.querySelector("#apply-result")
const matrixDownload = document.querySelector("#matrix-download")
const outputDownload = document.querySelector("#output-download")
const matrixSource = document.querySelector("#matrix-source")

let generatedTransform
let matrixUrl
let outputUrl

function setStatus(element, message, error = false) {
  element.textContent = message
  element.classList.toggle("error", error)
}

function setBusy(button, busy, busyLabel) {
  if (busy) {
    button.dataset.label = button.querySelector("span").textContent
    button.querySelector("span").textContent = busyLabel
  } else if (button.dataset.label) {
    button.querySelector("span").textContent = button.dataset.label
  }
  button.disabled = busy
}

async function errorMessage(response) {
  try {
    const body = await response.json()
    return body.error || `Request failed (${response.status})`
  } catch {
    return `Request failed (${response.status})`
  }
}

function metric(label, value) {
  const wrapper = document.createElement("div")
  const term = document.createElement("dt")
  const description = document.createElement("dd")
  term.textContent = label
  description.textContent = value
  wrapper.append(term, description)
  return wrapper
}

document.querySelectorAll("[data-file-name]").forEach((label) => {
  const input = document.querySelector(`#${label.dataset.fileName}`)
  input.addEventListener("change", () => {
    label.textContent = input.files[0]?.name || (
      input.id === "transform-file"
        ? "Choose existing matrix"
        : "Choose LightBurn file"
    )
  })
})

learnForm.addEventListener("submit", async (event) => {
  event.preventDefault()
  learnResult.hidden = true
  setStatus(learnStatus, "")
  setBusy(learnButton, true, "Fitting matrix…")
  try {
    const response = await fetch("/api/learn", {
      method: "POST",
      body: new FormData(learnForm),
    })
    if (!response.ok) throw new Error(await errorMessage(response))
    const data = await response.json()
    const transformText = `${JSON.stringify(data.transform, null, 2)}\n`
    generatedTransform = new File(
      [transformText],
      data.transformFileName,
      { type: "application/json" },
    )
    if (matrixUrl) URL.revokeObjectURL(matrixUrl)
    matrixUrl = URL.createObjectURL(generatedTransform)
    matrixDownload.href = matrixUrl
    matrixDownload.download = generatedTransform.name

    document.querySelector("#matrix-summary").textContent =
      `${data.summary.matchedPaths} matched paths · rank ${data.summary.matrixRank}`
    const metrics = document.querySelector("#matrix-metrics")
    metrics.replaceChildren(
      metric("Fit points", data.summary.fittedPoints.toLocaleString()),
      metric("RMS error", `${data.summary.rmsErrorMm.toFixed(6)} mm`),
      metric("Verify", `${data.summary.verificationErrorMm.toFixed(6)} mm`),
    )
    matrixSource.textContent =
      `Using generated ${generatedTransform.name} · ${data.transform.format}`
    matrixSource.classList.add("ready")
    learnResult.hidden = false
    setStatus(
      learnStatus,
      data.warnings.length
        ? `Ready with ${data.warnings.length} parser warning(s).`
        : "Ready to apply.",
    )
  } catch (error) {
    generatedTransform = undefined
    matrixSource.textContent = "No generated matrix is loaded yet."
    matrixSource.classList.remove("ready")
    setStatus(learnStatus, error.message, true)
  } finally {
    setBusy(learnButton, false)
  }
})

applyForm.addEventListener("submit", async (event) => {
  event.preventDefault()
  applyResult.hidden = true
  setStatus(applyStatus, "")
  const transformInput = document.querySelector("#transform-file")
  const transform = transformInput.files[0] || generatedTransform
  if (!transform) {
    setStatus(
      applyStatus,
      "Generate a matrix above or choose an existing transform JSON.",
      true,
    )
    return
  }

  setBusy(applyButton, true, "Transforming project…")
  try {
    const form = new FormData()
    form.set("transform", transform)
    form.set("input", document.querySelector("#input-file").files[0])
    const response = await fetch("/api/apply", { method: "POST", body: form })
    if (!response.ok) throw new Error(await errorMessage(response))
    const output = await response.blob()
    const outputFileName =
      response.headers.get("X-Output-File") || "project_transformed.lbrn2"
    if (outputUrl) URL.revokeObjectURL(outputUrl)
    outputUrl = URL.createObjectURL(output)
    outputDownload.href = outputUrl
    outputDownload.download = outputFileName
    document.querySelector("#output-summary").textContent =
      `${response.headers.get("X-Corrected-Shapes")} shapes corrected`
    applyResult.hidden = false
    const outside = Number(response.headers.get("X-Outside-Points") || 0)
    setStatus(
      applyStatus,
      outside > 0
        ? `${outside.toLocaleString()} generated points were extrapolated beyond the tooling frame.`
        : "All generated points were inside the tooling frame.",
    )
  } catch (error) {
    setStatus(applyStatus, error.message, true)
  } finally {
    setBusy(applyButton, false)
  }
})

window.addEventListener("beforeunload", () => {
  if (matrixUrl) URL.revokeObjectURL(matrixUrl)
  if (outputUrl) URL.revokeObjectURL(outputUrl)
})
