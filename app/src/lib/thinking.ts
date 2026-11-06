// Changes to a Thinking Space that the canvas and the Material panel both make.
import type { Cluster, Thinking } from './api.ts'

export const newId = () => Math.random().toString(36).slice(2, 10)

/** Fresh clusters from the model. Labels the writer renamed survive regrouping when their theme is still there. */
export function mergeClusters(prev: Cluster[] | undefined, fresh: { label: string; ids: string[] }[]): Cluster[] {
  const mine = (prev ?? []).filter((c) => c.mine)
  return fresh.map((c) => {
    const kept = mine.find((m) => m.ids.some((id) => c.ids.includes(id)))
    return { id: newId(), label: kept?.label ?? c.label, mine: !!kept, ids: c.ids }
  })
}

/** Take a fragment out, with its links and everything Ekdanta noted about it. */
export function withoutFragment(t: Thinking, id: string): Thinking {
  const { [id]: _r, ...recall } = t.side.recall ?? {}
  const { [id]: _c, ...checked } = t.side.checked ?? {}
  return {
    canvas: { nodes: t.canvas.nodes.filter((n) => n.id !== id), edges: t.canvas.edges.filter((e) => e.fromNode !== id && e.toNode !== id) },
    side: { ...t.side, recall, checked, clusters: t.side.clusters?.map((c) => ({ ...c, ids: c.ids.filter((x) => x !== id) })).filter((c) => c.ids.length) },
  }
}
