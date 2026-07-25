import type { LightBurnXmlContent, LightBurnXmlNode } from "../types.js"

export function isElement(content: LightBurnXmlContent): content is LightBurnXmlNode {
  return content.kind === "element"
}

export function childElements(node: LightBurnXmlNode, name?: string): LightBurnXmlNode[] {
  return node.children.filter(
    (child): child is LightBurnXmlNode => isElement(child) && (name === undefined || child.name === name),
  )
}

export function firstChild(node: LightBurnXmlNode, name: string): LightBurnXmlNode | undefined {
  return childElements(node, name)[0]
}

export function textContent(node: LightBurnXmlNode | undefined): string | undefined {
  if (!node) return undefined
  const value = node.children
    .filter((child) => child.kind === "text")
    .map((child) => child.value)
    .join("")
  return value === "" ? undefined : value
}

export function setTextElement(parent: LightBurnXmlNode, name: string, value: string): void {
  const existing = firstChild(parent, name)
  if (existing) {
    existing.children = [{ kind: "text", value }]
    return
  }
  parent.children.push({ kind: "element", name, attributes: {}, children: [{ kind: "text", value }] })
}

export function removeChildren(parent: LightBurnXmlNode, names: ReadonlySet<string>): void {
  parent.children = parent.children.filter(
    (child) => child.kind !== "element" || !names.has(child.name),
  )
}

export function cloneNode<T extends LightBurnXmlContent>(content: T): T {
  if (content.kind === "text") return { kind: "text", value: content.value } as T
  if (content.kind === "comment") return { kind: "comment", value: content.value } as T
  return {
    kind: "element",
    name: content.name,
    attributes: { ...content.attributes },
    children: content.children.map((child) => cloneNode(child)),
  } as T
}

export function findElements(node: LightBurnXmlNode, name: string): LightBurnXmlNode[] {
  const found: LightBurnXmlNode[] = []
  for (const child of childElements(node)) {
    if (child.name === name) found.push(child)
    found.push(...findElements(child, name))
  }
  return found
}
