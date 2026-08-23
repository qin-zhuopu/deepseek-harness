/** Sidebar footer button that toggles the VNC preview column. */

import { useSyncExternalStore } from 'react'
import { IconGlobeOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './PreviewToggle.module.css'

/** Props composed by the sidebar.footer.action slot plus the injected layout face. */
export type PreviewToggleProps =
  PropsRuntime<'sidebar.footer.action'> & { layout: ILayout }

/**
 * The footer toggle. Renders an icon-only control on the 56px rail and an
 * icon+label row when the sidebar is wide, mirroring the shipped footer
 * actions. Reflects and flips the layout's preview-column open state through
 * ctx.layout, so the button highlight tracks the column even when the column
 * is closed from its own header.
 * @param props - sidebar column state (`wide`) and the layout face.
 * @returns the footer toggle button.
 */
export function PreviewToggle({ wide, layout }: PreviewToggleProps): React.JSX.Element {
  const open = useSyncExternalStore(
    (fn) => layout.subscribe(fn),
    () => layout.isPreviewOpen(),
  )
  return (
    <div className={css.footerButtons}>
      <button
        type="button"
        className={css.badge}
        data-active={open || undefined}
        aria-label="预览浏览器"
        aria-expanded={open}
        onClick={() => { layout.togglePreview() }}
      >
        <IconGlobeOutline14 size={wide ? 16 : 18} />
        {wide && <span className={css.badgeLabel}>预览浏览器</span>}
      </button>
    </div>
  )
}
