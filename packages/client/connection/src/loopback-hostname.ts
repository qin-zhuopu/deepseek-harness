/**
 * Browser-safe, zero-dependency loopback classification shared by the `/api`
 * Host fence and the package's `ctx.connection` state. The predicate stays
 * package-internal; client plugins consume the derived state through Cordis.
 */

/**
 * Fixed company deployment hosts that reach a loopback-equivalent Host: the
 * settings/credentials RPCs are served over the same trusted transport there,
 * so the browser UI treats them as loopback for the settings-availability gate.
 */
const TRUSTED_HOSTNAMES = new Set([
  'dsh.gb10.zhuopu.net',
])

/**
 * Whether a normalized URL hostname names the local loopback authority.
 * @param hostname - WHATWG URL hostname (IPv6 literals retain brackets).
 * @returns true for localhost, IPv6 loopback, any IPv4 address in 127/8, or a trusted company host.
 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  if (TRUSTED_HOSTNAMES.has(hostname)) return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}
