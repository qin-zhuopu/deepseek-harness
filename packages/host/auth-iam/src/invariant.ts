/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-host-auth-iam`.
 * @module @deepseek-ai/dsh-host-auth-iam/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-auth-iam'

/** Cordis companion plugin name. */
export const name = 'host-auth-iam-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package owns no registry of its own — its
 * registrations are the webserver's guard seats and three named routes, whose
 * register/dispose symmetry the webserver companion already probes. The
 * sign-in round-trip, token verification, and their release on fiber disposal
 * are covered by the package's real-composition test instead.
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
