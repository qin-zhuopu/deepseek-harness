/** Right-rail icon button that toggles the files browser tab. */

import { useSyncExternalStore } from 'react'
import { IconFolderOpenOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import { setPreviewTab, subscribePreviewTab, getPreviewTab } from './preview-store.ts'
import css from './PreviewToggle.module.css'

/** Props composed by the rail.right.action slot plus the injected layout face. */
export type FilesToggleProps =
  PropsRuntime<'rail.right.action'> & { layout: ILayout }

/**
 * The right-rail files toggle: opens the preview column and switches to the
 * files tab. Highlighted when the files tab is active.
 */
export function FilesToggle({ layout }: FilesToggleProps): React.JSX.Element {
  const active = useSyncExternalStore(
    subscribePreviewTab,
    () => getPreviewTab() === 'files',
  )
  const open = useSyncExternalStore(
    fn => layout.subscribe(fn),
    () => layout.isPreviewOpen(),
  )
  return (
    <Tooltip label="文件" side="bottom" delayMs={500}>
      <button
        type="button"
        className={css.railButton}
        data-active={active || undefined}
        aria-label="文件"
        aria-expanded={open}
        onClick={() => { setPreviewTab('files'); layout.openPreview() }}
      >
        <IconFolderOpenOutline16 size={18} />
      </button>
    </Tooltip>
  )
}
