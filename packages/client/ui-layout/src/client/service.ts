/**
 * LayoutController: the cross-plugin panel-action face behind ctx.layout.
 * Panel geometry itself lives in the root entry's layout store (stores.ts);
 * the current-session selection lives with the runtime sessions service, and
 * the per-session active view dissolved into ui-conversation's session store
 * (its only consumer). What remains here is the contract other plugins'
 * apply worlds reach for panel transitions (sidebar toggle from ui-sidebar,
 * details open/close from ui-conversation) — writes stay inside the store's
 * declared action set, delivered as the registration's bound actions.
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { createLayoutStore } from './stores.ts'

/** The layout store's bound action set (framework-baked, draft params peeled). */
export type PanelActions = BoundActions<ReturnType<typeof createLayoutStore>>

/**
 * The outward layout face (`ctx.layout`): the panel transitions other
 * plugins may trigger — and exactly what a test fake must supply. The
 * attachPanels wiring hook stays on the concrete class (root-entry assembly
 * only).
 */
export interface ILayout {
  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void
  /** Open the details panel (no-op when already open). */
  openDetails(): void
  /** Close the details panel. */
  closeDetails(): void
  /** Toggle the right preview column (closed ⟷ contract default width). */
  togglePreview(): void
  /** Open the preview column (no-op when already open). */
  openPreview(): void
  /** Close the preview column. */
  closePreview(): void
  /** Whether the preview column is currently open. */
  isPreviewOpen(): boolean
  /**
   * Subscribe to layout panel-state changes (fires when preview opens/closes
   * or resizes). Returns an unsubscribe. Lets a cross-plugin control (a footer
   * toggle) reflect panel state through useSyncExternalStore.
   * @param fn - listener invoked on each layout store change.
   * @returns the unsubscribe function.
   */
  subscribe(fn: () => void): () => void
}

/** Cross-plugin panel-action face (ctx.layout). */
export class LayoutController implements ILayout {
  #panels: PanelActions | undefined
  // The inject hook delivers only the store's WRITE set (bound actions), never
  // its snapshot source, and AppFrame is a pure component that cannot push
  // state back. So the controller keeps an open/closed MIRROR for the preview
  // column: every open/close transition flows through these methods, and drag
  // resizes never cross the open line (stores.ts), so the mirror and the store
  // stay in lockstep. A cross-plugin control (the sidebar footer toggle) reads
  // and subscribes here to reflect preview state; the store has no
  // persistence, so a fresh entry starts closed exactly like this mirror.
  #previewOpen = false
  readonly #listeners = new Set<() => void>()

  /**
   * Adopt the root entry's bound store actions. Called from the root
   * registration's inject hook (a sanctioned assembly side effect), so the
   * face is live from the entry's first render; on entry re-register the
   * fresh actions overwrite the stale set.
   * @param actions - bound actions of the entry's layout store instance.
   */
  attachPanels(actions: PanelActions): void {
    this.#panels = actions
  }

  #emit(): void {
    for (const fn of [...this.#listeners]) fn()
  }

  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void {
    this.#require().toggleSidebar()
  }

  /** Open the details panel (no-op when already open). */
  openDetails(): void {
    this.#require().openDetails()
  }

  /** Close the details panel. */
  closeDetails(): void {
    this.#require().closeDetails()
  }

  /** Toggle the right preview column (closed ⟷ contract default width). */
  togglePreview(): void {
    this.#require().togglePreview()
    this.#previewOpen = !this.#previewOpen
    this.#emit()
  }

  /** Open the preview column (no-op when already open). */
  openPreview(): void {
    this.#require().openPreview()
    if (!this.#previewOpen) { this.#previewOpen = true; this.#emit() }
  }

  /** Close the preview column. */
  closePreview(): void {
    this.#require().closePreview()
    if (this.#previewOpen) { this.#previewOpen = false; this.#emit() }
  }

  /** Whether the preview column is currently open. */
  isPreviewOpen(): boolean {
    return this.#previewOpen
  }

  /**
   * Subscribe to preview open/close changes.
   * @param fn - listener invoked on each preview transition.
   * @returns the unsubscribe function.
   */
  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn)
    return () => { this.#listeners.delete(fn) }
  }

  #require(): PanelActions {
    // Callers are UI gestures, which cannot fire before the root entry
    // rendered (the inject hook runs in its first render) — reaching this
    // unwired is a boot-order bug, not a race to tolerate.
    if (this.#panels === undefined) throw new Error('layout: panel actions not wired (root entry not mounted)')
    return this.#panels
  }
}
