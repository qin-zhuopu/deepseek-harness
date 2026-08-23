/** Right-rail icon button that toggles the VNC preview column. */

import { useSyncExternalStore } from 'react'
import { IconGlobeOutline14, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import css from './PreviewToggle.module.css'

/** Props composed by the rail.right.action slot plus the injected layout face. */
export type PreviewToggleProps =
  PropsRuntime<'rail.right.action'> & { layout: ILayout }

/**
 * The right-rail toggle. Renders one icon-only control sized for the fixed
 * rail (mirroring the collapsed sidebar's rail icons) and reflects/flips the
 * layout's preview-column open state through ctx.layout, so the highlight
 * tracks the column even when it is closed from its own header.
 * @param props - the layout face (rail width arrives as an owner prop but the
 *   icon box is fixed by CSS).
 * @returns the rail toggle button.
 */
export function PreviewToggle({ layout }: PreviewToggleProps): React.JSX.Element {
  const open = useSyncExternalStore(
    (fn) => layout.subscribe(fn),
    () => layout.isPreviewOpen(),
  )
  return (
    <Tooltip label="预览浏览器" side="bottom" delayMs={500}>
      <button
        type="button"
        className={css.railButton}
        data-active={open || undefined}
        aria-label="预览浏览器"
        aria-expanded={open}
        onClick={() => { layout.togglePreview() }}
      >
        <IconGlobeOutline14 size={18} />
      </button>
    </Tooltip>
  )
}
