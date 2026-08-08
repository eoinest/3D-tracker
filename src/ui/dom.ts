export type Child = Node | string | number | null | undefined | false

/** Minimal hyperscript. Keeps the UI dependency-free without hand-rolled DOM soup. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)

  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue

    if (key === 'class') {
      node.className = String(value)
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(node.style, value)
    } else if (key === 'dataset' && typeof value === 'object') {
      Object.assign(node.dataset, value)
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
    } else if (key in node && typeof value !== 'object') {
      ;(node as unknown as Record<string, unknown>)[key] = value
    } else {
      node.setAttribute(key, String(value))
    }
  }

  append(node, children)
  return node
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)))
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}
