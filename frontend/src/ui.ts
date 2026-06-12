import { marked } from 'marked'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { fileUrl, type ItemDetail, type WorldItem } from './api'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export interface UIHandlers {
  onSearch(q: string): Promise<WorldItem[]>
  onPick(item: WorldItem): void
  onCreate(title: string, content: string, pos: [number, number, number]): Promise<void>
  onSave(id: number, content: string): Promise<ItemDetail>
  onDelete(id: number): Promise<void>
  onClose(): void
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export class UI {
  private panel = document.getElementById('panel')!
  private status = document.getElementById('status')!
  private pdfTask: pdfjs.PDFDocumentLoadingTask | null = null
  private session = 0 // invalidates in-flight pdf renders when the panel changes

  constructor(private handlers: UIHandlers) {
    this.bindSearch()
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hide()
    })
  }

  setStatus(text: string): void {
    this.status.textContent = text
  }

  hide(): void {
    this.session++
    void this.pdfTask?.destroy().catch(() => {})
    this.pdfTask = null
    this.panel.hidden = true
    this.panel.classList.remove('wide')
    this.handlers.onClose()
  }

  // -- item view -------------------------------------------------------------

  showItem(item: ItemDetail): void {
    this.session++
    void this.pdfTask?.destroy().catch(() => {})
    this.pdfTask = null
    this.panel.classList.toggle('wide', item.kind === 'pdf')
    const tags = item.tags
      .map((t) => `<span class="tag">#${escapeHtml(t)}</span>`)
      .join('')
    const actions =
      item.kind === 'note'
        ? `<button data-act="edit">edit</button><button data-act="delete" class="danger">delete</button>`
        : `<a href="${fileUrl(item.id)}" target="_blank" rel="noopener"><button>open file</button></a>
           <button data-act="delete" class="danger">delete</button>`
    this.panel.innerHTML = `
      <button class="close" title="close (esc)">×</button>
      <div class="kind">${item.kind}${item.pinned ? ' · pinned' : ''}</div>
      <h2>${escapeHtml(item.title)}</h2>
      <div class="tags">${tags}</div>
      <div class="actions">${actions}</div>
      <div class="content"></div>
      <div class="path">${escapeHtml(item.path)}</div>`
    this.panel.hidden = false
    this.panel.scrollTop = 0
    this.panel.querySelector('.close')!.addEventListener('click', () => this.hide())
    this.panel
      .querySelector('[data-act="delete"]')
      ?.addEventListener('click', () => void this.confirmDelete(item))
    this.panel
      .querySelector('[data-act="edit"]')
      ?.addEventListener('click', () => this.showEditor(item))

    const content = this.panel.querySelector<HTMLElement>('.content')!
    if (item.kind === 'note') {
      content.innerHTML = marked.parse(item.content, { async: false }) as string
    } else if (item.kind === 'pdf') {
      void this.renderPdf(item, content)
    } else {
      content.innerHTML = `<img class="full-image" src="${fileUrl(item.id)}" alt="${escapeHtml(item.title)}">`
    }
  }

  private async confirmDelete(item: ItemDetail): Promise<void> {
    const btn = this.panel.querySelector<HTMLButtonElement>('[data-act="delete"]')!
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1'
      btn.textContent = 'really delete?'
      setTimeout(() => {
        btn.dataset.armed = ''
        btn.textContent = 'delete'
      }, 2500)
      return
    }
    await this.handlers.onDelete(item.id)
    this.hide()
  }

  private showEditor(item: ItemDetail): void {
    const content = this.panel.querySelector<HTMLElement>('.content')!
    content.innerHTML = `
      <textarea class="editor" spellcheck="false"></textarea>
      <div class="editor-actions">
        <button class="primary" data-act="save">save</button>
        <button data-act="cancel">cancel</button>
      </div>`
    const textarea = content.querySelector<HTMLTextAreaElement>('.editor')!
    textarea.value = item.content
    textarea.focus()
    content.querySelector('[data-act="cancel"]')!.addEventListener('click', () => {
      this.showItem(item)
    })
    content.querySelector('[data-act="save"]')!.addEventListener('click', async () => {
      const save = content.querySelector<HTMLButtonElement>('[data-act="save"]')!
      save.disabled = true
      save.textContent = 'saving…'
      try {
        const updated = await this.handlers.onSave(item.id, textarea.value)
        this.showItem(updated)
      } catch {
        save.disabled = false
        save.textContent = 'failed — retry'
      }
    })
  }

  // -- pdf reader --------------------------------------------------------------

  private async renderPdf(item: ItemDetail, container: HTMLElement): Promise<void> {
    const session = this.session
    container.innerHTML = `<div class="pdf-loading">unrolling the scroll…</div>`
    const task = pdfjs.getDocument({ url: fileUrl(item.id) })
    let doc: pdfjs.PDFDocumentProxy
    try {
      doc = await task.promise
    } catch {
      container.innerHTML = `<div class="pdf-loading">could not load the PDF</div>`
      return
    }
    if (session !== this.session) {
      void task.destroy()
      return
    }
    this.pdfTask = task
    container.innerHTML = ''
    const pageCount = doc.numPages
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          observer.unobserve(entry.target)
          void renderPage(entry.target as HTMLElement)
        }
      },
      { root: this.panel, rootMargin: '600px' },
    )
    const renderPage = async (holder: HTMLElement): Promise<void> => {
      if (session !== this.session) return
      try {
        const page = await doc.getPage(Number(holder.dataset.page))
        if (session !== this.session) return
        const width = container.clientWidth - 4
        const base = page.getViewport({ scale: 1 })
        const viewport = page.getViewport({ scale: width / base.width })
        const canvas = document.createElement('canvas')
        const dpr = Math.min(devicePixelRatio, 2)
        canvas.width = Math.floor(viewport.width * dpr)
        canvas.height = Math.floor(viewport.height * dpr)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        const ctx = canvas.getContext('2d')!
        ctx.scale(dpr, dpr)
        await page.render({ canvasContext: ctx, viewport, canvas }).promise
        if (session !== this.session) return
        holder.replaceChildren(canvas)
        holder.style.height = ''
      } catch {
        /* page render cancelled or failed; leave the placeholder */
      }
    }
    for (let i = 1; i <= pageCount; i++) {
      const holder = document.createElement('div')
      holder.className = 'page'
      holder.dataset.page = String(i)
      holder.style.height = '520px'
      container.appendChild(holder)
      observer.observe(holder)
    }
  }

  // -- create form --------------------------------------------------------------

  showCreateForm(pos: [number, number, number]): void {
    this.session++
    this.panel.classList.remove('wide')
    this.panel.innerHTML = `
      <button class="close" title="close (esc)">×</button>
      <div class="kind">new note · pinned here</div>
      <input id="new-title" placeholder="title" />
      <textarea id="new-content" class="editor" rows="12"
        placeholder="write… (#tags and [[wikilinks]] work)"></textarea>
      <div class="editor-actions">
        <button id="new-save" class="primary">place on the world</button>
      </div>`
    this.panel.hidden = false
    this.panel.querySelector('.close')!.addEventListener('click', () => this.hide())
    const title = this.panel.querySelector<HTMLInputElement>('#new-title')!
    const content = this.panel.querySelector<HTMLTextAreaElement>('#new-content')!
    const save = this.panel.querySelector<HTMLButtonElement>('#new-save')!
    title.focus()
    save.addEventListener('click', async () => {
      if (!title.value.trim()) {
        title.focus()
        return
      }
      save.disabled = true
      save.textContent = 'placing…'
      try {
        await this.handlers.onCreate(title.value.trim(), content.value, pos)
        this.hide()
      } catch {
        save.disabled = false
        save.textContent = 'failed — retry'
      }
    })
  }

  // -- search --------------------------------------------------------------------

  private bindSearch(): void {
    const input = document.getElementById('search') as HTMLInputElement
    const list = document.getElementById('results') as HTMLUListElement
    let timer: number | undefined
    input.addEventListener('input', () => {
      clearTimeout(timer)
      const q = input.value.trim()
      if (!q) {
        list.hidden = true
        return
      }
      timer = window.setTimeout(async () => {
        let results: WorldItem[] = []
        try {
          results = await this.handlers.onSearch(q)
        } catch {
          /* backend offline; leave list empty */
        }
        list.innerHTML = results
          .map(
            (r) => `<li><span class="glyph ${r.kind}">${
              r.kind === 'pdf' ? '⎘' : r.kind === 'image' ? '✦' : '¶'
            }</span> ${escapeHtml(r.title)}</li>`,
          )
          .join('')
        list.hidden = results.length === 0
        list.querySelectorAll('li').forEach((li, i) =>
          li.addEventListener('click', () => {
            this.handlers.onPick(results[i])
            list.hidden = true
            input.blur()
          }),
        )
      }, 250)
    })
    document.addEventListener('click', (e) => {
      if (!(e.target instanceof Node) || !list.parentElement!.contains(e.target)) {
        list.hidden = true
      }
    })
  }
}
