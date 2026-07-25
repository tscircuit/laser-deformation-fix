import type { LightBurnDocument, LightBurnXmlContent, LightBurnXmlNode } from "../types.js"

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;")
}

function serializeAttributes(attributes: Record<string, string>): string {
  return Object.entries(attributes)
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join("")
}

function serializeContent(content: LightBurnXmlContent, depth: number): string {
  const indent = "    ".repeat(depth)
  if (content.kind === "text") return escapeText(content.value.trim())
  if (content.kind === "comment") return `${indent}<!--${content.value.replaceAll("--", "- -")}-->`
  return serializeNode(content, depth)
}

function serializeNode(node: LightBurnXmlNode, depth: number): string {
  const indent = "    ".repeat(depth)
  const attributes = serializeAttributes(node.attributes)
  if (node.children.length === 0) return `${indent}<${node.name}${attributes}/>`
  const inline = node.children.every((child) => child.kind === "text")
  if (inline) {
    return `${indent}<${node.name}${attributes}>${node.children.map((child) => serializeContent(child, 0)).join("")}</${node.name}>`
  }
  const children = node.children.map((child) => serializeContent(child, depth + 1)).join("\n")
  return `${indent}<${node.name}${attributes}>\n${children}\n${indent}</${node.name}>`
}

export function serializeLightBurn(document: LightBurnDocument): string {
  const declaration = Object.entries(document.declaration)
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join("")
  return `<?xml${declaration}?>\n${serializeNode(document.root, 0)}\n`
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error("Cannot serialize a non-finite number")
  const normalized = Math.abs(value) < 5e-10 ? 0 : value
  return normalized.toFixed(8).replace(/(?:\.0+|(\.\d+?)0+)$/, "$1")
}
