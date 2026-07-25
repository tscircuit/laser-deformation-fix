import { extname } from "node:path"
import { XMLParser, XMLValidator } from "fast-xml-parser"
import { XmlFormatError } from "../errors.js"
import type {
  LightBurnDocument,
  LightBurnFormat,
  LightBurnXmlContent,
  LightBurnXmlNode,
} from "../types.js"
import { findElements } from "./node-utils.js"

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function attributesOf(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const attributes: Record<string, string> = {}
  for (const [name, raw] of Object.entries(value)) attributes[name] = String(raw)
  return attributes
}

function textFrom(raw: unknown): string {
  if (!Array.isArray(raw)) return ""
  for (const item of raw) {
    if (isRecord(item) && typeof item["#text"] === "string") return item["#text"]
  }
  return ""
}

function convertElement(record: UnknownRecord): LightBurnXmlNode | undefined {
  const name = Object.keys(record).find((key) => key !== ":@")
  if (!name || name === "?xml" || name === "#comment" || name === "#text") return undefined
  const rawChildren = record[name]
  const children: LightBurnXmlContent[] = []
  if (Array.isArray(rawChildren)) {
    for (const rawChild of rawChildren) {
      if (!isRecord(rawChild)) continue
      if (typeof rawChild["#text"] === "string") {
        const value = rawChild["#text"]
        if (value.trim() !== "") children.push({ kind: "text", value })
      } else if (Array.isArray(rawChild["#comment"])) {
        children.push({ kind: "comment", value: textFrom(rawChild["#comment"]) })
      } else {
        const element = convertElement(rawChild)
        if (element) children.push(element)
      }
    }
  }
  return { kind: "element", name, attributes: attributesOf(record[":@"]) , children }
}

function parseBooleanFlag(
  root: LightBurnXmlNode,
  name: "MirrorX" | "MirrorY",
  warnings: string[],
): boolean {
  const raw = root.attributes[name]
  if (raw === undefined) {
    warnings.push(`${name} is absent; treating it as False`)
    return false
  }
  if (/^true$/i.test(raw)) return true
  if (/^false$/i.test(raw)) return false
  throw new XmlFormatError(`Invalid ${name} value ${JSON.stringify(raw)}; expected True or False`)
}

function detectFormat(root: LightBurnXmlNode, sourceName?: string): LightBurnFormat {
  const extension = sourceName ? extname(sourceName).toLowerCase() : ""
  if (extension === ".lbrn2") return "lbrn2"
  if (extension === ".lbrn") return "lbrn"
  if (findElements(root, "VertList").length > 0) return "lbrn2"
  if (findElements(root, "V").length > 0) return "lbrn"
  throw new XmlFormatError("Cannot detect LightBurn format; use a .lbrn2 or .lbrn filename")
}

export function parseLightBurn(xml: string, sourceName?: string): LightBurnDocument {
  const validation = XMLValidator.validate(xml)
  if (validation !== true) {
    const message = isRecord(validation) && isRecord(validation.err)
      ? String(validation.err.msg ?? "invalid XML")
      : "invalid XML"
    throw new XmlFormatError(`Invalid XML: ${message}`)
  }
  let parsed: unknown
  try {
    parsed = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      attributeNamePrefix: "",
      commentPropName: "#comment",
      trimValues: false,
      parseTagValue: false,
      parseAttributeValue: false,
    }).parse(xml)
  } catch (error) {
    throw new XmlFormatError(`Invalid XML: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(parsed)) throw new XmlFormatError("Invalid XML document structure")
  let root: LightBurnXmlNode | undefined
  let declaration: Record<string, string> = { version: "1.0", encoding: "UTF-8" }
  for (const raw of parsed) {
    if (!isRecord(raw)) continue
    if (Object.hasOwn(raw, "?xml")) declaration = attributesOf(raw[":@"])
    else if (!root) root = convertElement(raw)
  }
  if (!root || root.name !== "LightBurnProject") {
    throw new XmlFormatError("Unknown LightBurn format: expected <LightBurnProject> root")
  }
  const warnings: string[] = []
  return {
    root,
    declaration,
    format: detectFormat(root, sourceName),
    mirrorX: parseBooleanFlag(root, "MirrorX", warnings),
    mirrorY: parseBooleanFlag(root, "MirrorY", warnings),
    warnings,
  }
}
