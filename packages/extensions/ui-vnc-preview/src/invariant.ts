/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-vnc-preview`.
 * @module @deepseek-ai/dsh-client-ui-vnc-preview/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-vnc-preview'

/** Cordis companion plugin name. */
export const name = 'client-ui-vnc-preview-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the plugin registers a sidebar footer action and a
 * shell.overlay entry, both list slots whose disposal is owned by the slot
 * runtime. The one mutable relation this package owns — the open/url preview
 * store — lives in the browser process, out of reach of the host invariant
 * service, and the node half emits no cordis events and holds no cross-plugin
 * state.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
