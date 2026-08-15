<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue'

const isOpen = ref(false)
const svgContainerRef = ref<HTMLElement | null>(null)
const scale = ref(1)
const translateX = ref(0)
const translateY = ref(0)
const isDragging = ref(false)
const startX = ref(0)
const startY = ref(0)
let currentSourceSvg: SVGSVGElement | null = null

function openModal(svgElement: SVGSVGElement) {
  currentSourceSvg = svgElement
  scale.value = 1.1
  translateX.value = 0
  translateY.value = 0
  isOpen.value = true
  
  if (typeof document !== 'undefined') {
    document.body.style.overflow = 'hidden'
  }

  nextTick(() => {
    if (svgContainerRef.value && currentSourceSvg) {
      // Safe DOM cloning without innerHTML / v-html string injection
      const cloned = currentSourceSvg.cloneNode(true) as SVGSVGElement
      cloned.removeAttribute('id')
      cloned.style.maxWidth = '90vw'
      cloned.style.maxHeight = '85vh'
      cloned.style.width = 'auto'
      cloned.style.height = 'auto'
      cloned.style.background = 'transparent'
      svgContainerRef.value.replaceChildren(cloned)
    }
  })
}

function closeModal() {
  isOpen.value = false
  currentSourceSvg = null
  if (svgContainerRef.value) {
    svgContainerRef.value.replaceChildren()
  }
  if (typeof document !== 'undefined') {
    document.body.style.overflow = ''
  }
}

function zoomIn() {
  scale.value = Math.min(scale.value * 1.25, 6)
}

function zoomOut() {
  scale.value = Math.max(scale.value / 1.25, 0.3)
}

function resetZoom() {
  scale.value = 1
  translateX.value = 0
  translateY.value = 0
}

function handleWheel(e: WheelEvent) {
  e.preventDefault()
  if (e.deltaY < 0) {
    zoomIn()
  } else {
    zoomOut()
  }
}

// Pointer Events for unified Mouse & Touch drag-to-pan
function handlePointerDown(e: PointerEvent) {
  if (e.button !== 0 && e.pointerType === 'mouse') return
  isDragging.value = true
  startX.value = e.clientX - translateX.value
  startY.value = e.clientY - translateY.value
  const target = e.currentTarget as HTMLElement
  if (target && target.setPointerCapture) {
    try {
      target.setPointerCapture(e.pointerId)
    } catch (_) {}
  }
}

function handlePointerMove(e: PointerEvent) {
  if (!isDragging.value) return
  translateX.value = e.clientX - startX.value
  translateY.value = e.clientY - startY.value
}

function handlePointerUp(e: PointerEvent) {
  isDragging.value = false
  const target = e.currentTarget as HTMLElement
  if (target && target.releasePointerCapture) {
    try {
      target.releasePointerCapture(e.pointerId)
    } catch (_) {}
  }
}

function handleViewportClick(e: MouseEvent) {
  // Allow clicking anywhere on the empty backdrop to close
  if (e.target === e.currentTarget || (svgContainerRef.value && !svgContainerRef.value.contains(e.target as Node))) {
    closeModal()
  }
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && isOpen.value) {
    closeModal()
  }
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null

function attachMermaidListeners() {
  if (typeof document === 'undefined') return
  
  const contentArea = document.querySelector('.VPContent') || document.body
  const targets = contentArea.querySelectorAll('.mermaid, [data-mermaid], .vp-mermaid')
  
  targets.forEach((container) => {
    const el = container as HTMLElement
    if (el.dataset.zoomAttached) return
    el.dataset.zoomAttached = 'true'
    el.classList.add('mermaid-interactive')
    el.title = 'Click to zoom and pan diagram'

    el.addEventListener('click', () => {
      const svg = el.querySelector('svg')
      if (svg) {
        openModal(svg)
      }
    })
  })
}

function debouncedAttach() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    nextTick(() => {
      attachMermaidListeners()
    })
  }, 120)
}

let observer: MutationObserver | null = null

onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', handleKeyDown)
    attachMermaidListeners()

    // Scoped observation on content container with debouncing
    const targetNode = document.querySelector('.VPContent') || document.body
    observer = new MutationObserver((mutations) => {
      const hasAddedNodes = mutations.some((m) => m.addedNodes && m.addedNodes.length > 0)
      if (hasAddedNodes) {
        debouncedAttach()
      }
    })

    observer.observe(targetNode, {
      childList: true,
      subtree: true
    })
  }
})

onUnmounted(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('keydown', handleKeyDown)
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer)
  }
  if (observer) {
    observer.disconnect()
  }
})
</script>

<template>
  <div v-if="isOpen" class="mermaid-modal-overlay" @click.self="closeModal">
    <div class="mermaid-modal-toolbar">
      <span class="mermaid-modal-hint">Drag to Pan • Scroll to Zoom</span>
      <button class="modal-btn" @click="zoomIn" title="Zoom In">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
      </button>
      <button class="modal-btn" @click="zoomOut" title="Zoom Out">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
      </button>
      <button class="modal-btn" @click="resetZoom" title="Reset Zoom">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
      </button>
      <button class="modal-btn modal-btn-close" @click="closeModal" title="Close (Esc)">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>

    <div
      class="mermaid-modal-viewport"
      @click="handleViewportClick"
      @wheel="handleWheel"
      @pointerdown="handlePointerDown"
      @pointermove="handlePointerMove"
      @pointerup="handlePointerUp"
      @pointercancel="handlePointerUp"
    >
      <div
        ref="svgContainerRef"
        class="mermaid-modal-content"
        :style="{
          transform: `translate(${translateX}px, ${translateY}px) scale(${scale})`,
          cursor: isDragging ? 'grabbing' : 'grab'
        }"
      ></div>
    </div>
  </div>
</template>

<style scoped>
.mermaid-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 99999;
  background: rgba(0, 0, 0, 0.9);
  backdrop-filter: blur(10px);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  user-select: none;
}

.mermaid-modal-toolbar {
  position: absolute;
  top: 18px;
  right: 24px;
  display: flex;
  align-items: center;
  gap: 8px;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 8px;
  padding: 6px 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
  z-index: 100000;
}

.mermaid-modal-hint {
  font-size: 12px;
  color: #8b949e;
  margin-right: 6px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.modal-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 6px;
  border: 1px solid #30363d;
  background: #161b22;
  color: #c9d1d9;
  cursor: pointer;
  transition: all 0.15s ease;
}

.modal-btn:hover {
  background: #21262d;
  border-color: #8b949e;
  color: #ffffff;
}

.modal-btn-close:hover {
  background: rgba(248, 81, 73, 0.15);
  border-color: #f85149;
  color: #f85149;
}

.mermaid-modal-viewport {
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  touch-action: none;
}

.mermaid-modal-content {
  transform-origin: center center;
  transition: transform 0.05s ease-out;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.mermaid-modal-content :deep(svg) {
  max-width: 90vw;
  max-height: 85vh;
  width: auto !important;
  height: auto !important;
  background: transparent !important;
  pointer-events: auto;
}
</style>
