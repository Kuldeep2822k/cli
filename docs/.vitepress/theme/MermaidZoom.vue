<script setup lang="ts">
import { onMounted, onUnmounted, nextTick } from 'vue'

interface DiagramController {
  card: HTMLElement
  viewport: HTMLElement
  svg: SVGSVGElement
  scale: number
  x: number
  y: number
  isDragging: boolean
  lastPointerX: number
  lastPointerY: number
  activePointers: Map<number, { x: number; y: number }>
  initialPinchDist: number
  initialPinchScale: number
  rafId: number | null
  applyTransform: () => void
  reset: () => void
  zoom: (factor: number, originX?: number, originY?: number) => void
  destroy: () => void
}

const activeCards: HTMLElement[] = []

function attachDiagramController(card: HTMLElement) {
  if (card.dataset.panzoomAttached) return
  card.dataset.panzoomAttached = 'true'
  activeCards.push(card)

  const svg = card.querySelector('svg')
  if (!svg) return

  card.classList.add('mermaid-diagram-card')

  // Create inner viewport if not present
  let viewport = card.querySelector('.mermaid-viewport') as HTMLElement
  if (!viewport) {
    viewport = document.createElement('div')
    viewport.className = 'mermaid-viewport'
    
    // Move SVG into viewport
    svg.parentNode?.insertBefore(viewport, svg)
    viewport.appendChild(svg)
  }

  // Create GitHub-style Toolbar
  const toolbar = document.createElement('div')
  toolbar.className = 'github-diagram-toolbar'

  // Zoom In button
  const zoomInBtn = document.createElement('button')
  zoomInBtn.className = 'gh-diag-btn'
  zoomInBtn.title = 'Zoom In (+)'
  zoomInBtn.setAttribute('aria-label', 'Zoom In')
  zoomInBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>`

  // Zoom Out button
  const zoomOutBtn = document.createElement('button')
  zoomOutBtn.className = 'gh-diag-btn'
  zoomOutBtn.title = 'Zoom Out (-)'
  zoomOutBtn.setAttribute('aria-label', 'Zoom Out')
  zoomOutBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>`

  // Reset button
  const resetBtn = document.createElement('button')
  resetBtn.className = 'gh-diag-btn'
  resetBtn.title = 'Reset (100%)'
  resetBtn.setAttribute('aria-label', 'Reset')
  resetBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`

  // Fullscreen button
  const fullscreenBtn = document.createElement('button')
  fullscreenBtn.className = 'gh-diag-btn'
  fullscreenBtn.title = 'Toggle Fullscreen (Esc to exit)'
  fullscreenBtn.setAttribute('aria-label', 'Toggle Fullscreen')
  fullscreenBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>`

  toolbar.appendChild(zoomInBtn)
  toolbar.appendChild(zoomOutBtn)
  toolbar.appendChild(resetBtn)
  toolbar.appendChild(fullscreenBtn)
  card.appendChild(toolbar)

  // Initialize controller state
  const state: DiagramController = {
    card,
    viewport,
    svg,
    scale: 1,
    x: 0,
    y: 0,
    isDragging: false,
    lastPointerX: 0,
    lastPointerY: 0,
    activePointers: new Map(),
    initialPinchDist: 0,
    initialPinchScale: 1,
    rafId: null,
    applyTransform() {
      if (state.rafId) cancelAnimationFrame(state.rafId)
      state.rafId = requestAnimationFrame(() => {
        svg.style.transform = `translate3d(${state.x}px, ${state.y}px, 0px) scale(${state.scale})`
      })
    },
    reset() {
      state.scale = 1
      state.x = 0
      state.y = 0
      state.applyTransform()
    },
    zoom(factor, originX, originY) {
      const oldScale = state.scale
      const newScale = Math.min(Math.max(oldScale * factor, 0.25), 8)
      if (Math.abs(newScale - oldScale) < 0.001) return

      if (originX !== undefined && originY !== undefined) {
        const ratio = newScale / oldScale
        state.x = originX - (originX - state.x) * ratio
        state.y = originY - (originY - state.y) * ratio
      }
      state.scale = newScale
      state.applyTransform()
    },
    destroy() {
      if (state.rafId) cancelAnimationFrame(state.rafId)
    }
  }

  // Toolbar events
  zoomInBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    const rect = viewport.getBoundingClientRect()
    state.zoom(1.25, rect.width / 2, rect.height / 2)
  })

  zoomOutBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    const rect = viewport.getBoundingClientRect()
    state.zoom(1 / 1.25, rect.width / 2, rect.height / 2)
  })

  resetBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    state.reset()
  })

  function toggleFullscreen() {
    if (card.classList.contains('is-fullscreen')) {
      card.classList.remove('is-fullscreen')
      fullscreenBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>`
      document.body.style.overflow = ''
    } else {
      card.classList.add('is-fullscreen')
      fullscreenBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>`
      document.body.style.overflow = 'hidden'
    }
    state.reset()
  }

  fullscreenBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    toggleFullscreen()
  })

  // Wheel zoom centered on mouse
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault()
    const rect = viewport.getBoundingClientRect()
    const originX = e.clientX - rect.left
    const originY = e.clientY - rect.top
    const factor = e.ctrlKey ? Math.exp(-e.deltaY * 0.01) : (e.deltaY < 0 ? 1.15 : 1 / 1.15)
    state.zoom(factor, originX, originY)
  }, { passive: false })

  // Double click to toggle 2x or reset
  viewport.addEventListener('dblclick', (e) => {
    e.preventDefault()
    if (state.scale > 1.05 || state.scale < 0.95 || state.x !== 0 || state.y !== 0) {
      state.reset()
    } else {
      const rect = viewport.getBoundingClientRect()
      state.zoom(2, e.clientX - rect.left, e.clientY - rect.top)
    }
  })

  // Pointer drag events with hardware acceleration
  viewport.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    try {
      viewport.setPointerCapture(e.pointerId)
    } catch (_) {}
    state.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (state.activePointers.size === 1) {
      state.isDragging = true
      state.lastPointerX = e.clientX
      state.lastPointerY = e.clientY
      viewport.classList.add('is-dragging')
    } else if (state.activePointers.size === 2) {
      state.isDragging = false
      const pts = Array.from(state.activePointers.values())
      state.initialPinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      state.initialPinchScale = state.scale
    }
  })

  viewport.addEventListener('pointermove', (e) => {
    if (!state.activePointers.has(e.pointerId)) return
    state.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (state.activePointers.size === 1 && state.isDragging) {
      const dx = e.clientX - state.lastPointerX
      const dy = e.clientY - state.lastPointerY
      state.lastPointerX = e.clientX
      state.lastPointerY = e.clientY
      state.x += dx
      state.y += dy
      state.applyTransform()
    } else if (state.activePointers.size === 2 && state.initialPinchDist > 0) {
      const pts = Array.from(state.activePointers.values())
      const currentDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      const factor = currentDist / state.initialPinchDist
      state.scale = Math.min(Math.max(state.initialPinchScale * factor, 0.25), 8)
      state.applyTransform()
    }
  })

  const endDrag = (e: PointerEvent) => {
    state.activePointers.delete(e.pointerId)
    try {
      viewport.releasePointerCapture(e.pointerId)
    } catch (_) {}
    if (state.activePointers.size === 0) {
      state.isDragging = false
      viewport.classList.remove('is-dragging')
    } else if (state.activePointers.size === 1) {
      const remaining = Array.from(state.activePointers.values())[0]
      state.isDragging = true
      state.lastPointerX = remaining.x
      state.lastPointerY = remaining.y
    }
  }

  viewport.addEventListener('pointerup', endDrag)
  viewport.addEventListener('pointercancel', endDrag)
}

function handleGlobalKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    activeCards.forEach((card) => {
      if (card.classList.contains('is-fullscreen')) {
        card.classList.remove('is-fullscreen')
        const fullscreenBtn = card.querySelector('.gh-diag-btn[title*="Fullscreen"]')
        if (fullscreenBtn) {
          fullscreenBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>`
        }
      }
    })
    document.body.style.overflow = ''
  }
}

function scanAndAttach() {
  if (typeof document === 'undefined') return
  const contentArea = document.querySelector('.VPContent') || document.body
  const diagrams = contentArea.querySelectorAll('.mermaid, [data-mermaid], .vp-mermaid')
  diagrams.forEach((diagram) => {
    attachDiagramController(diagram as HTMLElement)
  })
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null

function debouncedScan() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    nextTick(() => {
      scanAndAttach()
    })
  }, 100)
}

let observer: MutationObserver | null = null

onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', handleGlobalKeyDown)
    scanAndAttach()

    const target = document.querySelector('.VPContent') || document.body
    observer = new MutationObserver(() => {
      debouncedScan()
    })

    observer.observe(target, {
      childList: true,
      subtree: true
    })
  }
})

onUnmounted(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('keydown', handleGlobalKeyDown)
  }
  if (debounceTimer) clearTimeout(debounceTimer)
  if (observer) observer.disconnect()
})
</script>

<template>
  <div class="mermaid-panzoom-runtime"></div>
</template>

<style scoped>
.mermaid-panzoom-runtime {
  display: none;
}
</style>
