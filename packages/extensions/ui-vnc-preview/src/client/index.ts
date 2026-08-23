/**
 * VNC preview, browser half. Registers two surfaces: a toggle icon in the
 * always-present right icon rail (`rail.right.action`) and the right-edge
 * `preview` layout column that embeds a Chrome noVNC page in an iframe.
 *
 * Unlike a floating overlay, the preview column is a real grid track: opening
 * or resizing it squeezes the center conversation (the layout concession
 * solve, ui-layout). The toggle lives on the right rail (mirroring the left
 * sidebar's icon rail) so the control sits on the same side as the panel it
 * opens. Open/close and width are owned by `ctx.layout`; this plugin only
 * contributes the rail toggle and the column body.
 *
 * The noVNC URL defaults to the local Chrome-over-noVNC endpoint and can be
 * overridden at boot via `window.__DSH_VNC_PREVIEW_URL__` (an index injection
 * or a container-baked script), so the same bundle serves the local desktop
 * GUI and the in-container all-in-one image.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: merges the preview + rail.right.action seats into SlotMap and
// augments ctx.layout.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { PreviewToggle } from './PreviewToggle.tsx'
import { PreviewPanel } from './PreviewPanel.tsx'

/**
 * Default noVNC page for the local Chrome-over-noVNC setup. `resize=scale`
 * makes noVNC scale the whole remote desktop to fit the iframe (preserving
 * aspect ratio) instead of showing a 1:1 slice of the fixed-resolution Xvfb
 * canvas — so the picture follows the preview column width as it is dragged.
 */
const DEFAULT_VNC_URL = 'http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale'

/** Read the boot-time URL override, falling back to the local default. */
function resolveVncUrl(): string {
  const override = (globalThis as { __DSH_VNC_PREVIEW_URL__?: unknown }).__DSH_VNC_PREVIEW_URL__
  return typeof override === 'string' && override.length > 0 ? override : DEFAULT_VNC_URL
}

/** Services required by the preview plugin. */
export const inject = ['slots', 'layout']

/**
 * Register the right-rail toggle icon and the preview-column body. Both reach
 * `ctx.layout` for the shared open/close state; the panel additionally reads
 * the noVNC URL through its inject face.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  const url = resolveVncUrl()
  const layout = ctx.layout

  ctx.slots.inject('rail.right.action', () => ctx.slots.register({
    name: 'rail.right.action',
    id: 'vnc-preview',
    order: 50,
    inject: () => ({ layout }),
  }, PreviewToggle))

  ctx.slots.inject('preview', () => ctx.slots.register({
    name: 'preview',
    inject: () => ({ url, layout }),
  }, PreviewPanel))
}
