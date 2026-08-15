<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue'

const isModalOpen = ref(false)
const modalSvgContainer = ref<HTMLElement | null>(null)
const modalScale = ref(1)
const modalTranslateX = ref(0)
const modalTranslateY = ref(0)
const isDragging = ref(false)
const dragStartX = ref(0)
const dragStartY = ref(0)

function openModal(svgElement: SVGSVGElement) {
  isModalOpen.value = true
  modalScale.value = 1
  modalTranslateX.value = 0
  modalTranslateY.value = 0

  if (typeof document !== 'undefined') {
    document.body.style.overflow = 'hidden'
  }

  nextTick(() => {
    if (modalSvgContainer.value) {
      // Clone exact SVG node preserving all ID attributes, inline styles, and viewBox
      const clone = svgElement.cloneNode(true) as SVGSVGElement
      
      // Ensure SVG has proper viewBox and sizing
      const viewBox = clone.getAttribute('viewBox')
      if (viewBox) {
        const parts = viewBox.split(/[\s,]+/).map(Number)
        if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
          clone.setAttribute('width', `${parts[2]}`)
          clone.setAttribute('height', `${parts[3]}`)
        }
      }
      clone.style.maxWidth = '92vw'
      clone.style.maxHeight = '82vh'
      clone.style.display = 'block'
      clone.style.margin = 'auto'
      
      modalSvgContainer.value.replaceChildren(clone)
    }
  })
}

function closeModal() {
  isModalOpen.value = false
  if (modalSvgContainer.value) {
    modalSvgContainer.value.replaceChildren()
  }
  if (typeof document !== 'undefined') {
    document.body.style.overflow = ''
  }
}

function zoomIn() {
  modalScale.value = Math.min(modalScale.value * 1.25, 5)
}

function zoomOut() {
  modalScale.value = Math.max(modalScale.value / 1.25, 0.4)
}

function resetZoom() {
  modalScale.value = 1
  modalTranslateX.value = 0
  modalTranslateY.value = 0
}

function handleWheel(e: WheelEvent) {
  e.preventDefault()
  if (e.deltaY < 0) {
    zoomIn()
  } else {
    zoomOut()
  }
}

function handlePointerDown(e: PointerEvent) {
  if (e.button !== 0 && e.pointerType === 'mouse') return
  isDragging.value = true
  dragStartX.value = e.clientX - modalTranslateX.value
  dragStartY.value = e.clientY - modalTranslateY.value
  const target = e.currentTarget as HTMLElement
  if (target?.setPointerCapture) {
    try {
      target.setPointerCapture(e.pointerId)
    } catch (_) {}
  }
}

function handlePointerMove(e: PointerEvent) {
  if (!isDragging.value) return
  modalTranslateX.value = e.clientX - dragStartX.value
  modalTranslateY.value = e.clientY - dragStartY.value
}

function handlePointerUp(e: PointerEvent) {
  isDragging.value = false
  const target = e.currentTarget as HTMLElement
  if (target?.releasePointerCapture) {
    try {
      target.releasePointerCapture(e.pointerId)
    } catch (_) {}
  }
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && isModalOpen.value) {
    closeModal()
  }
}

// Enhance diagrams with top toolbar on the page
function setupDiagramToolbars() {
  if (typeof document === 'undefined') return
  
  const contentArea = document.querySelector('.VPContent') || document.body
  const diagrams = contentArea.querySelectorAll('.mermaid, [data-mermaid], .vp-mermaid')
  
  diagrams.forEach((container) => {
    const el = container as HTMLElement
    if (el.dataset.toolbarAttached) return
    el.dataset.toolbarAttached = 'true'

    // Create diagram container wrapper
    el.classList.add('mermaid-diagram-card')

    // Create action toolbar
    const toolbar = document.createElement('div')
    toolbar.className = 'diagram-card-toolbar'

    // Fullscreen button
    const expandBtn = document.createElement('button')
    expandBtn.className = 'diagram-toolbar-btn'
    expandBtn.title = 'Open Fullscreen Zoom & Pan'
    expandBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg><span>Inspect</span>`

    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      const svg = el.querySelector('svg')
      if (svg) {
        openModal(svg)
      }
    })

    toolbar.appendChild(expandBtn)
    el.appendChild(toolbar)

    // Clicking anywhere on the diagram also opens fullscreen inspection
    el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      if (target.closest('.diagram-card-toolbar')) return
      const svg = el.querySelector('svg')
      if (svg) {
        openModal(svg)
      }
    })
  })
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null

function debouncedSetup() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    nextTick(() => {
      setupDiagramToolbars()
    })
  }, 150)
}

let observer: MutationObserver | null = null

onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', handleKeyDown)
    setupDiagramToolbars()

    const target = document.querySelector('.VPContent') || document.body
    observer = new MutationObserver((mutations) => {
      const hasNewElements = mutations.some((m) => m.addedNodes && m.addedNodes.length > 0)
      if (hasNewElements) {
        debouncedSetup()
      }
    })

    observer.observe(target, {
      childList: true,
      subtree: true
    })
  }
})

onUnmounted(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('keydown', handleKeyDown)
  }
  if (debounceTimer) clearTimeout(debounceTimer)
  if (observer) observer.disconnect()
})
</script>

<template>
  <div v-if="isModalOpen" class="diagram-fullscreen-modal">
    <!-- Modal Backdrop -->
    <div class="modal-backdrop" @click="closeModal"></div>

    <!-- Modal Header Toolbar -->
    <div class="modal-header-toolbar">
      <div class="modal-title-hint">
        <span class="hint-dot"></span>
        <span>Drag to pan • Scroll to zoom</span>
      </div>
      <div class="modal-actions-group">
        <button class="modal-tool-btn" @click="zoomIn" title="Zoom In (+)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
        </button>
        <button class="modal-tool-btn" @click="zoomOut" title="Zoom Out (-)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
        </button>
        <button class="modal-tool-btn" @click="resetZoom" title="Reset (100%)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
        </button>
        <div class="modal-divider"></div>
        <button class="modal-tool-btn close-btn" @click="closeModal" title="Close (Esc)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>

    <!-- Modal Viewport Canvas -->
    <div
      class="modal-canvas-viewport"
      @wheel="handleWheel"
      @pointerdown="handlePointerDown"
      @pointermove="handlePointerMove"
      @pointerup="handlePointerUp"
      @pointercancel="handlePointerUp"
    >
      <div
        ref="modalSvgContainer"
        class="modal-svg-stage"
        :style="{
          transform: `translate(${modalTranslateX}px, ${modalTranslateY}px) scale(${modalScale})`,
          cursor: isDragging ? 'grabbing' : 'grab'
        }"
      ></div>
    </div>
  </div>
</template>

<style scoped>
.diagram-fullscreen-modal {
  position: fixed;
  inset: 0;
  z-index: 99999;
  display: flex;
  flex-direction: column;
  user-select: none;
}

.modal-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(5, 7, 10, 0.94);
  backdrop-filter: blur(12px);
}

.modal-header-toolbar {
  position: absolute;
  top: 18px;
  right: 24px;
  left: 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  z-index: 100000;
  pointer-events: none;
}

.modal-title-hint {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: #0e1117;
  border: 1px solid #21262d;
  border-radius: 20px;
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 500;
  color: #8b949e;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
  pointer-events: auto;
}

.hint-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #3b82f6;
  box-shadow: 0 0 8px #3b82f6;
}

.modal-actions-group {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: #0e1117;
  border: 1px solid #21262d;
  border-radius: 10px;
  padding: 5px 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
  pointer-events: auto;
}

.modal-tool-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: #c9d1d9;
  cursor: pointer;
  transition: all 0.15s ease;
}

.modal-tool-btn:hover {
  background: #161b22;
  border-color: #30363d;
  color: #ffffff;
}

.modal-tool-btn.close-btn:hover {
  background: rgba(239, 68, 68, 0.15);
  border-color: #ef4444;
  color: #ef4444;
}

.modal-divider {
  width: 1px;
  height: 18px;
  background: #21262d;
  margin: 0 4px;
}

.modal-canvas-viewport {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  touch-action: none;
  z-index: 99999;
}

.modal-svg-stage {
  transform-origin: center center;
  transition: transform 0.04s ease-out;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
  pointer-events: auto;
}

.modal-svg-stage :deep(svg) {
  filter: drop-shadow(0 12px 36px rgba(0, 0, 0, 0.8));
}
</style>
