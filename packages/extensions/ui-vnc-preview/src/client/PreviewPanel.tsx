/** Preview-column body: a tab header (browser / files) that fills the
 *  right-edge layout column with the selected iframe. */

import { useRef } from 'react'
import { useSyncExternalStore } from 'react'
import { IconCloseOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import { getPreviewTab, setPreviewTab, subscribePreviewTab } from './preview-store.ts'
import css from './PreviewPanel.module.css'

/** Props: the preview owner share (open/width) plus the injected urls and layout face. */
export type PreviewPanelProps =
  PropsRuntime<'preview'> & { url: string; filesUrl: string; layout: ILayout }

/**
 * The preview column body. The layout owns the column's open state and width
 * (this component fills whatever width the concession solve grants), so it
 * renders nothing while the column is closed — the subtree stays mounted at
 * zero width like details. It offers two tabs — browser (the noVNC page) and
 * files (a web file browser) — plus reload / close controls; close routes
 * through ctx.layout so the sidebar toggle's highlight stays in sync.
 */
export function PreviewPanel({ open, url, filesUrl, layout }: PreviewPanelProps): React.JSX.Element | null {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const tab = useSyncExternalStore(subscribePreviewTab, getPreviewTab)

  if (!open) return null

  const reload = (): void => {
    const frame = frameRef.current
    // Reassigning src forces a reload without needing same-origin access to
    // the iframe's contentWindow (the noVNC page is a different origin/port).
    if (frame !== null) frame.src = tab === 'browser' ? url : filesUrl
  }

  const frameSrc = tab === 'browser' ? url : filesUrl

  return (
    <div className={css.panel} role="complementary" aria-label="预览">
      <header className={css.header}>
        <div className={css.tabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'browser'}
            className={css.tab}
            data-active={tab === 'browser' || undefined}
            onClick={() => { setPreviewTab('browser') }}
          >
            浏览器
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'files'}
            className={css.tab}
            data-active={tab === 'files' || undefined}
            onClick={() => { setPreviewTab('files') }}
          >
            文件
          </button>
        </div>
        <div className={css.actions}>
          <Tooltip label="刷新" side="bottom" delayMs={500}>
            <button type="button" className={css.action} aria-label="刷新" onClick={reload}>
              <span className={css.reloadGlyph} aria-hidden="true">⟳</span>
            </button>
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
        key={tab}
        ref={frameRef}
        className={css.frame}
        src={frameSrc}
        title={tab === 'browser' ? '浏览器预览' : '文件浏览'}
        // Allow the embedded remote desktop the capabilities noVNC needs while
        // keeping it sandboxed from the host page.
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-pointer-lock"
      />
    </div>
  )
}
