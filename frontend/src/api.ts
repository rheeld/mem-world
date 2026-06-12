const BASE = '/api'

export interface WorldItem {
  id: number
  path: string
  kind: 'note' | 'pdf' | 'image'
  title: string
  tags: string[]
  pos: [number, number, number]
  pinned: boolean
  distance?: number | null
}

export interface WorldState {
  rev: number
  items: WorldItem[]
  links: [number, number][]
}

export interface ItemDetail extends WorldItem {
  content: string
  modified_at: number
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return res.json() as Promise<T>
}

async function sendJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status}`)
  return res.json() as Promise<T>
}

/** Returns null when the world is unchanged since `since`. */
export async function fetchWorld(since?: number): Promise<WorldState | null> {
  const url = since === undefined ? `${BASE}/world` : `${BASE}/world?since=${since}`
  const data = await getJson<WorldState & { unchanged?: boolean }>(url)
  return data.unchanged ? null : data
}

export function fetchItem(id: number): Promise<ItemDetail> {
  return getJson(`${BASE}/items/${id}`)
}

export function fileUrl(id: number): string {
  return `${BASE}/items/${id}/file`
}

export async function searchWorld(q: string): Promise<WorldItem[]> {
  const data = await getJson<{ results: WorldItem[] }>(
    `${BASE}/search?q=${encodeURIComponent(q)}`,
  )
  return data.results
}

export function createNote(
  title: string,
  content: string,
  pos?: [number, number, number],
): Promise<ItemDetail> {
  return sendJson(`${BASE}/items`, 'POST', { title, content, pos })
}

export function updateNote(id: number, content: string): Promise<ItemDetail> {
  return sendJson(`${BASE}/items/${id}`, 'PUT', { content })
}

export function deleteItem(id: number): Promise<{ ok: boolean }> {
  return sendJson(`${BASE}/items/${id}`, 'DELETE')
}
