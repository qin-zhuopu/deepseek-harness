/** Preview-column body: fills the right-edge layout column with a noVNC iframe. */

import { useRef } from 'react'
import { IconCloseOutline16, IconFullscreenOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import css from './PreviewPanel.module.css'

/** Props: the preview owner share (open/width) plus the injected url and layout face. */
export type PreviewPanelProps =
  PropsRuntime<'preview'> & { url: string; layout: ILayout }

/**
 * The preview column body. The layout owns the column's open state and width
 * (this component fills whatever width the concession solve grants), so it
 * renders nothing while the column is closed — the subtree stays mounted at
 * zero width like details. It embeds the noVNC page in an iframe and offers
 * close / open-in-new-tab / reload controls; close routes through ctx.layout
 * so the sidebar toggle's highlight stays in sync.
 * @param props - owner column state, the noVNC URL, and the layout face.
 * @returns the column body while open, otherwise nothing.
 */
export function PreviewPanel({ open, url, layout }: PreviewPanelProps): React.JSX.Element | null {
  const frameRef = useRef<HTMLIFrameElement>(null)

  if (!open) return null

  const reload = (): void => {
    const frame = frameRef.current
    // Reassigning src forces a reload without needing same-origin access to
    // the iframe's contentWindow (the noVNC page is a different origin/port).
    if (frame !== null) frame.src = url
  }

  return (
    <div className={css.panel} role="complementary" aria-label="浏览器预览">
      <header className={css.header}>
        <span className={css.title}>浏览器预览</span>
        <div className={css.actions}>
          <Tooltip label="刷新" side="bottom" delayMs={500}>
            <button type="button" className={css.action} aria-label="刷新" onClick={reload}>
              <span className={css.reloadGlyph} aria-hidden="true">⟳</span>
            </button>
          </Tooltip>
          <Tooltip label="在新标签页打开" side="bottom" delayMs={500}>
            <a
              className={css.action}
              href={url}
              target="_blank"
              rel="noreferrer"
              aria-label="在新标签页打开"
            >
              <IconFullscreenOutline16 size={16} />
            </a>
          </Tooltip>
          <Tooltip label="关闭" side="bottom" delayMs={500}>
            <button
              type="button"
              className={css.action}
              aria-label="关闭"
              onClick={() => { layout.closePreview() }}
            >
              <IconCloseOutline16 size={16} />
            </button>
          </Tooltip>
        </div>
      </header>
      <iframe
        ref={frameRef}
        className={css.frame}
        src={url}
        title="浏览器预览"
        // Allow the embedded remote desktop the capabilities noVNC needs while
        // keeping it sandboxed from the host page.
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-pointer-lock"
      />
    </div>
  )
}
