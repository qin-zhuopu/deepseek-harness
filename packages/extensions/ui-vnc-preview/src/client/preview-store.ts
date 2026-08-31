/**
 * Tiny external store for which preview tab is active. Shared by the two
 * right-rail toggles and the preview panel so the rail highlight and the
 * panel's tab header stay in sync across components without routing every
 * toggle through the layout concession.
 */

/** The two preview tabs. */
export type PreviewTab = 'browser' | 'files'

let tab: PreviewTab = 'browser'
const listeners = new Set<() => void>()

/** Read the active preview tab. */
export function getPreviewTab(): PreviewTab {
  return tab
}

/** Subscribe to tab changes; returns an unsubscribe function. */
export function subscribePreviewTab(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Switch the active preview tab. */
export function setPreviewTab(next: PreviewTab): void {
  if (tab === next) return
  tab = next
  for (const fn of listeners) fn()
}
