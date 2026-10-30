<script setup lang="ts">
import { nextTick, onMounted, onUnmounted } from 'vue'
import { onContentUpdated } from 'vitepress'
import { mermaidConfig } from '../mermaid-theme'
import { normalizeMermaidSource } from '../mermaid-compat'

const ICONS = {
  expand:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.28 4.22a.75.75 0 0 1 0 1.06L2.56 7H7a.75.75 0 0 1 0 1.5H2.56l1.72 1.72a.75.75 0 1 1-1.06 1.06l-3-3a.75.75 0 0 1 0-1.06l3-3a.75.75 0 0 1 1.06 0Z"/><path d="M11.72 4.22a.75.75 0 0 1 1.06 0l3 3a.75.75 0 0 1 0 1.06l-3 3a.75.75 0 1 1-1.06-1.06L13.44 8.5H9a.75.75 0 0 1 0-1.5h4.44l-1.72-1.72a.75.75 0 0 1 0-1.06Z"/></svg>',
  copy: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>',
  check:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>',
  close:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>',
  reset:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z"/></svg>',
  zoomIn:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"/><path d="M7 4.75a.75.75 0 0 1 .75.75v.75h.75a.75.75 0 0 1 0 1.5h-.75v.75a.75.75 0 0 1-1.5 0v-.75h-.75a.75.75 0 0 1 0-1.5h.75v-.75A.75.75 0 0 1 7 4.75Z"/></svg>',
  zoomOut:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"/><path d="M4.75 6.25h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5Z"/></svg>'
} as const

const MIN_SCALE = 0.2
const MAX_SCALE = 8

interface Controller {
  closeViewer: () => void
  destroy: () => void
}

const controllers: Controller[] = []
let activeClose: (() => void) | null = null
let observer: MutationObserver | null = null
let scanTimer: ReturnType<typeof setTimeout> | null = null

type MermaidApi = typeof import('mermaid')['default']
let mermaidPromise: Promise<MermaidApi> | null = null
let diagramId = 0
const renderQueue: HTMLElement[] = []
let draining = false

// Load Mermaid only when the page actually contains a diagram. Waiting for
// webfonts avoids node labels being measured with fallback metrics and then
// overflowing once the real font swaps in.
function getMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    const fontsReady =
      typeof document !== 'undefined' && document.fonts ? document.fonts.ready : Promise.resolve()
    mermaidPromise = Promise.all([import('mermaid'), fontsReady]).then(([{ default: mermaid }]) => {
      mermaid.initialize(mermaidConfig)
      return mermaid
    })
  }
  return mermaidPromise
}

function enqueueRender(block: HTMLElement) {
  if (block.dataset.mermaidState) return
  block.dataset.mermaidState = 'queued'
  renderQueue.push(block)
  void drainQueue()
}

// Render one diagram at a time; mermaid.render is not safe to interleave with
// other renders in the same document.
async function drainQueue() {
  if (draining) return
  draining = true
  try {
    while (renderQueue.length) {
      const block = renderQueue.shift()!
      if (!block.isConnected) continue
      const target = block.querySelector<HTMLElement>('.mermaid')
      const encoded = block.dataset.graph
      if (!target || !encoded) {
        block.dataset.mermaidState = 'error'
        continue
      }
      try {
        const mermaid = await getMermaid()
        const { svg } = await mermaid.render(
          `palee-mermaid-${diagramId++}`,
          normalizeMermaidSource(decodeURIComponent(encoded))
        )
        target.innerHTML = svg
        block.dataset.mermaidState = 'rendered'
        attach(block)
      } catch (error) {
        block.dataset.mermaidState = 'error'
        block.classList.add('mermaid-error')
        target.textContent = decodeURIComponent(encoded)
        console.error('[mermaid] failed to render diagram', error)
      }
    }
  } finally {
    draining = false
  }
}

function makeButton(className: string, label: string, icon: string) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.title = label
  button.setAttribute('aria-label', label)
  button.innerHTML = icon
  return button
}

function div(className: string) {
  const element = document.createElement('div')
  element.className = className
  return element
}

function attach(block: HTMLElement) {
  if (block.dataset.mermaidEnhanced) return
  const mermaidEl = block.querySelector<HTMLElement>('.mermaid')
  if (!mermaidEl || !mermaidEl.querySelector('svg')) return
  block.dataset.mermaidEnhanced = 'true'

  const inlineListeners = new AbortController()
  const signal = inlineListeners.signal
  const source = block.dataset.graph ? decodeURIComponent(block.dataset.graph) : ''

  const toolbar = div('mermaid-toolbar')
  const expandBtn = makeButton('mermaid-tool', 'Expand diagram', ICONS.expand)
  const copyBtn = makeButton('mermaid-tool', 'Copy diagram source', ICONS.copy)
  toolbar.append(expandBtn, copyBtn)
  block.appendChild(toolbar)

  async function copySource(button: HTMLButtonElement) {
    if (!source) return
    try {
      await navigator.clipboard.writeText(source)
    } catch {
      return
    }
    button.innerHTML = ICONS.check
    button.title = 'Copied'
    button.classList.add('is-copied')
    setTimeout(() => {
      button.innerHTML = ICONS.copy
      button.title = 'Copy diagram source'
      button.classList.remove('is-copied')
    }, 1500)
  }

  copyBtn.addEventListener('click', () => copySource(copyBtn), { signal })

  let modal: HTMLDivElement | null = null
  let stage: HTMLDivElement | null = null
  let canvas: HTMLDivElement | null = null
  let modalListeners: AbortController | null = null
  let lastFocused: HTMLElement | null = null
  let savedOverflow = ''
  let savedSvgStyle: string | null = null
  let naturalWidth = 0
  let naturalHeight = 0
  let scale = 1
  let x = 0
  let y = 0
  let rafId = 0

  function applyView() {
    if (!canvas) return
    if (rafId) cancelAnimationFrame(rafId)
    rafId = requestAnimationFrame(() => {
      if (!canvas) return
      canvas.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
    })
  }

  function fitView() {
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    const margin = 64
    // Fit the width and keep 100% when there is room, like GitHub's viewer;
    // taller diagrams pan vertically instead of shrinking to thumbnail size.
    const fit = Math.min(1, (rect.width - margin) / naturalWidth)
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, fit))
    x = (rect.width - naturalWidth * scale) / 2
    const scaledHeight = naturalHeight * scale
    y = scaledHeight < rect.height ? (rect.height - scaledHeight) / 2 : margin / 2
    applyView()
  }

  function zoomAt(factor: number, clientX: number, clientY: number) {
    if (!canvas) return
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor))
    if (Math.abs(next - scale) < 0.001) return
    const rect = canvas.getBoundingClientRect()
    const ratio = next / scale
    x += (clientX - rect.left) * (1 - ratio)
    y += (clientY - rect.top) * (1 - ratio)
    scale = next
    applyView()
  }

  function zoomFromCenter(factor: number) {
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2)
  }

  const pointers = new Map<number, { x: number; y: number }>()
  let isDragging = false
  let lastX = 0
  let lastY = 0
  let pinchStart = 0
  let pinchScale = 1

  function closeModal() {
    if (!modal) return
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
    pointers.clear()
    isDragging = false
    lastX = 0
    lastY = 0
    pinchStart = 0
    pinchScale = 1
    stage?.classList.remove('is-dragging')
    modalListeners?.abort()
    modalListeners = null

    const svg = canvas?.querySelector('svg')
    if (svg && svg.isConnected) {
      if (savedSvgStyle === null) svg.removeAttribute('style')
      else svg.setAttribute('style', savedSvgStyle)
      mermaidEl.appendChild(svg)
    }
    mermaidEl.style.minHeight = ''

    modal.remove()
    modal = null
    stage = null
    canvas = null
    document.body.style.overflow = savedOverflow
    if (lastFocused?.isConnected) lastFocused.focus()
    lastFocused = null
    if (activeClose === closeModal) activeClose = null
  }

  function openModal() {
    if (modal) return
    const svg = mermaidEl.querySelector('svg')
    if (!svg) return
    if (activeClose) activeClose()

    lastFocused =
      document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement
        : expandBtn
    savedOverflow = document.body.style.overflow
    savedSvgStyle = svg.getAttribute('style')

    const viewBox = svg.viewBox?.baseVal
    naturalWidth =
      viewBox && viewBox.width > 0 ? viewBox.width : svg.getBoundingClientRect().width
    naturalHeight =
      viewBox && viewBox.height > 0 ? viewBox.height : svg.getBoundingClientRect().height
    const inlineHeight = svg.getBoundingClientRect().height
    scale = 1
    x = 0
    y = 0

    modal = div('mermaid-modal')
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    modal.setAttribute('aria-label', 'Diagram viewer')

    const modalToolbar = div('mermaid-modal-toolbar')
    const closeBtn = makeButton('mermaid-tool', 'Close diagram viewer', ICONS.close)
    modalToolbar.append(closeBtn)

    stage = div('mermaid-modal-stage')
    canvas = div('mermaid-modal-canvas')
    canvas.appendChild(svg)
    stage.appendChild(canvas)
    mermaidEl.style.minHeight = `${inlineHeight}px`

    const controls = div('mermaid-modal-controls')
    const zoomInBtn = makeButton('mermaid-modal-btn', 'Zoom in', ICONS.zoomIn)
    const zoomOutBtn = makeButton('mermaid-modal-btn', 'Zoom out', ICONS.zoomOut)
    const resetBtn = makeButton('mermaid-modal-btn', 'Reset view', ICONS.reset)
    controls.append(zoomInBtn, zoomOutBtn, resetBtn)

    modal.append(modalToolbar, stage, controls)
    document.body.appendChild(modal)
    document.body.style.overflow = 'hidden'

    svg.style.maxWidth = 'none'
    svg.style.width = `${naturalWidth}px`
    svg.style.height = `${naturalHeight}px`

    activeClose = closeModal
    modalListeners = new AbortController()
    const msignal = modalListeners.signal

    closeBtn.addEventListener('click', closeModal, { signal: msignal })
    zoomInBtn.addEventListener('click', () => zoomFromCenter(1.2), { signal: msignal })
    zoomOutBtn.addEventListener('click', () => zoomFromCenter(1 / 1.2), { signal: msignal })
    resetBtn.addEventListener('click', fitView, { signal: msignal })
    window.addEventListener('resize', fitView, { signal: msignal })

    stage.addEventListener(
      'pointerdown',
      (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return
        stage.setPointerCapture(event.pointerId)
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
        if (pointers.size === 1) {
          isDragging = true
          lastX = event.clientX
          lastY = event.clientY
          stage.classList.add('is-dragging')
        } else if (pointers.size === 2) {
          isDragging = false
          const [a, b] = [...pointers.values()]
          pinchStart = Math.hypot(a.x - b.x, a.y - b.y)
          pinchScale = scale
        }
      },
      { signal: msignal }
    )

    stage.addEventListener(
      'pointermove',
      (event) => {
        if (!pointers.has(event.pointerId)) return
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
        if (pointers.size === 1 && isDragging) {
          x += event.clientX - lastX
          y += event.clientY - lastY
          lastX = event.clientX
          lastY = event.clientY
          applyView()
        } else if (pointers.size === 2 && pinchStart > 0) {
          const [a, b] = [...pointers.values()]
          const distance = Math.hypot(a.x - b.x, a.y - b.y)
          scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, pinchScale * (distance / pinchStart)))
          applyView()
        }
      },
      { signal: msignal }
    )

    function endDrag(event: PointerEvent) {
      pointers.delete(event.pointerId)
      if (stage?.hasPointerCapture(event.pointerId)) {
        stage.releasePointerCapture(event.pointerId)
      }
      if (pointers.size === 0) {
        isDragging = false
        stage?.classList.remove('is-dragging')
      } else if (pointers.size === 1) {
        const [remaining] = [...pointers.values()]
        isDragging = true
        lastX = remaining.x
        lastY = remaining.y
      }
    }

    stage.addEventListener('pointerup', endDrag, { signal: msignal })
    stage.addEventListener('pointercancel', endDrag, { signal: msignal })

    stage.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault()
        if (event.ctrlKey || event.metaKey) {
          zoomAt(event.deltaY < 0 ? 1.08 : 1 / 1.08, event.clientX, event.clientY)
        } else {
          x -= event.deltaX
          y -= event.deltaY
          applyView()
        }
      },
      { passive: false, signal: msignal }
    )

    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          closeModal()
          return
        }
        if (event.key === 'Tab' && modal) {
          const focusable = [...modal.querySelectorAll<HTMLButtonElement>('button')]
          if (!focusable.length) return
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
          return
        }
        let handled = true
        switch (event.key) {
          case 'ArrowUp':
            y += 48
            applyView()
            break
          case 'ArrowDown':
            y -= 48
            applyView()
            break
          case 'ArrowLeft':
            x += 48
            applyView()
            break
          case 'ArrowRight':
            x -= 48
            applyView()
            break
          case '+':
          case '=':
            zoomFromCenter(1.2)
            break
          case '-':
          case '_':
            zoomFromCenter(1 / 1.2)
            break
          case '0':
            fitView()
            break
          default:
            handled = false
        }
        if (handled) event.preventDefault()
      },
      { signal: msignal }
    )

    requestAnimationFrame(() => {
      fitView()
      closeBtn.focus()
    })
  }

  expandBtn.addEventListener('click', openModal, { signal })

  controllers.push({
    closeViewer: closeModal,
    destroy() {
      closeModal()
      inlineListeners.abort()
      toolbar.remove()
      delete block.dataset.mermaidEnhanced
    }
  })
}

function destroyAll() {
  for (const controller of controllers.splice(0)) {
    controller.destroy()
  }
  activeClose = null
  document.body.style.overflow = ''
}

function scan() {
  document.querySelectorAll<HTMLElement>('.mermaid-block').forEach((block) => {
    const state = block.dataset.mermaidState
    if (state === 'rendered') {
      if (!block.dataset.mermaidEnhanced) attach(block)
      return
    }
    if (state) return
    if (block.querySelector('.mermaid svg')) {
      block.dataset.mermaidState = 'rendered'
      attach(block)
      return
    }
    enqueueRender(block)
  })
}

function scheduleScan() {
  if (scanTimer) clearTimeout(scanTimer)
  scanTimer = setTimeout(() => {
    nextTick(scan)
  }, 100)
}

function onGlobalKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape' && activeClose) {
    event.preventDefault()
    activeClose()
  }
}

onContentUpdated(() => {
  destroyAll()
  nextTick(scan)
})

onMounted(() => {
  window.addEventListener('keydown', onGlobalKeyDown)
  scan()
  const target = document.querySelector('.VPContent') || document.body
  observer = new MutationObserver(() => scheduleScan())
  observer.observe(target, { childList: true, subtree: true })
})

onUnmounted(() => {
  window.removeEventListener('keydown', onGlobalKeyDown)
  if (scanTimer) clearTimeout(scanTimer)
  observer?.disconnect()
  destroyAll()
})
</script>

<template>
  <div class="mermaid-runtime" aria-hidden="true"></div>
</template>

<style>
.mermaid-runtime {
  display: none;
}
</style>
