/**
 * VNC preview sidebar, browser half. Registers two surfaces:
 * a sidebar footer toggle button and the right-edge `preview` layout column
 * that embeds a Chrome noVNC page in an iframe.
 *
 * Unlike a floating overlay, the preview column is a real grid track: opening
 * or resizing it squeezes the center conversation (the layout concession
 * solve, ui-layout). Open/close and width are owned by `ctx.layout`; this
 * plugin only contributes the button that toggles it and the column body.
 *
 * The noVNC URL defaults to the local Chrome-over-noVNC endpoint and can be
 * overridden at boot via `window.__DSH_VNC_PREVIEW_URL__` (an index injection
 * or a container-baked script), so the same bundle serves the local desktop
 * GUI and the in-container all-in-one image.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: merges the sidebar.footer.action seat into SlotMap.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: merges the preview seat into SlotMap and augments ctx.layout.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { PreviewToggle } from './PreviewToggle.tsx'
import { PreviewPanel } from './PreviewPanel.tsx'

/** Default noVNC page for the local Chrome-over-noVNC setup. */
const DEFAULT_VNC_URL = 'http://127.0.0.1:6080/vnc.html'

/** Read the boot-time URL override, falling back to the local default. */
function resolveVncUrl(): string {
  const override = (globalThis as { __DSH_VNC_PREVIEW_URL__?: unknown }).__DSH_VNC_PREVIEW_URL__
  return typeof override === 'string' && override.length > 0 ? override : DEFAULT_VNC_URL
}

/** Services required by the preview plugin. */
export const inject = ['slots', 'layout']

/**
 * Register the footer toggle button and the preview-column body. Both reach
 * `ctx.layout` for the shared open/close state; the panel additionally reads
 * the noVNC URL through its inject face.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  const url = resolveVncUrl()
  const layout = ctx.layout

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'vnc-preview',
    order: 50,
    inject: () => ({ layout }),
  }, PreviewToggle))

  ctx.slots.inject('preview', () => ctx.slots.register({
    name: 'preview',
    inject: () => ({ url, layout }),
  }, PreviewPanel))
}
