/**
 * LayoutController behavior: the cross-plugin panel-action face. Geometry
 * lives in the entry store (layout-store.spec.ts) — here we assert the
 * delegation contract: attachPanels wiring, the three actions forwarding, the
 * unwired fail-loud, and re-attach overwriting a stale action set.
 */
import { describe, expect, it, vi } from 'vitest'
import { LayoutController } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'
import type { PanelActions } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'

function fakePanels(): PanelActions {
  return {
    setSidebar: vi.fn(),
    setDetails: vi.fn(),
    setPreview: vi.fn(),
    toggleSidebar: vi.fn(),
    togglePreview: vi.fn(),
    setNarrow: vi.fn(),
    openDetails: vi.fn(),
    closeDetails: vi.fn(),
    openPreview: vi.fn(),
    closePreview: vi.fn(),
  }
}

describe('LayoutController', () => {
  it('forwards the three panel actions to the attached set', () => {
    const service = new LayoutController()
    const panels = fakePanels()
    service.attachPanels(panels)

    service.toggleSidebar()
    service.openDetails()
    service.closeDetails()

    expect(panels.toggleSidebar).toHaveBeenCalledTimes(1)
    expect(panels.openDetails).toHaveBeenCalledTimes(1)
    expect(panels.closeDetails).toHaveBeenCalledTimes(1)
    expect(panels.setSidebar).not.toHaveBeenCalled()
    expect(panels.setDetails).not.toHaveBeenCalled()
  })

  it('fails loud before the root entry wired its actions', () => {
    const service = new LayoutController()
    expect(() => { service.toggleSidebar() }).toThrow(/panel actions not wired/)
    expect(() => { service.openDetails() }).toThrow(/panel actions not wired/)
    expect(() => { service.closeDetails() }).toThrow(/panel actions not wired/)
  })

  it('re-attach overwrites the stale action set (entry re-register)', () => {
    const service = new LayoutController()
    const stale = fakePanels()
    const fresh = fakePanels()
    service.attachPanels(stale)
    service.attachPanels(fresh)

    service.toggleSidebar()

    expect(stale.toggleSidebar).not.toHaveBeenCalled()
    expect(fresh.toggleSidebar).toHaveBeenCalledTimes(1)
  })

  it('forwards the preview actions to the attached set', () => {
    const service = new LayoutController()
    const panels = fakePanels()
    service.attachPanels(panels)

    service.togglePreview()
    service.openPreview()
    service.closePreview()

    expect(panels.togglePreview).toHaveBeenCalledTimes(1)
    expect(panels.openPreview).toHaveBeenCalledTimes(1)
    expect(panels.closePreview).toHaveBeenCalledTimes(1)
  })

  it('mirrors preview open state and notifies subscribers on each transition', () => {
    const service = new LayoutController()
    service.attachPanels(fakePanels())
    const listener = vi.fn()
    const off = service.subscribe(listener)

    expect(service.isPreviewOpen()).toBe(false)
    service.togglePreview()
    expect(service.isPreviewOpen()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)

    // openPreview while already open is a no-op for the mirror (no extra notify).
    service.openPreview()
    expect(listener).toHaveBeenCalledTimes(1)

    service.closePreview()
    expect(service.isPreviewOpen()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)

    off()
    service.togglePreview()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('preview reads fail loud before the root entry wired its actions', () => {
    const service = new LayoutController()
    expect(() => { service.togglePreview() }).toThrow(/panel actions not wired/)
  })
})
