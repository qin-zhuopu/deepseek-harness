#!/usr/bin/env node
// front-proxy — one network-facing port that fans out to the three local
// services, so the image works behind a reverse proxy.
//
// Why this exists: `dsh web` deliberately refuses to bind 0.0.0.0 ("it would
// expose remote code execution to the network"), so it is only ever reachable
// on 127.0.0.1 inside the container. A reverse proxy connects to the
// container's bridge IP and therefore cannot reach it at all. This proxy is
// the one process that does listen on the bridge, forwarding to loopback:
//
//   /resize      -> vnc-resize-sidecar   (SIDECAR_PORT, default 6081)
//   /vnc, /vnc/* -> noVNC/websockify     (NOVNC_PORT,   default 6080)
//   everything else -> dsh web           (DSH_PORT,     default 3080)
//
// One port also means one vhost, which is what nginx-proxy 1.3.0 supports
// (VIRTUAL_HOST_MULTIPORTS arrived later), and it puts all three behind the
// same origin — the preview iframe and the resize endpoint become plain
// same-origin paths, so the container never needs to know its public URL.
//
// WebSocket upgrades are forwarded raw (noVNC's RFB transport), and responses
// stream through untouched so dsh web's SSE channels keep working.
'use strict'

const http = require('node:http')
const net = require('node:net')

const FRONT_PORT = Number(process.env.FRONT_PORT || 8080)
const FRONT_BIND = process.env.FRONT_BIND || '0.0.0.0'
const WEB_PORT = Number(process.env.DSH_PORT || 3080)
const NOVNC_PORT = Number(process.env.NOVNC_PORT || 6080)
const SIDECAR_PORT = Number(process.env.SIDECAR_PORT || 6081)
const VNC_PREFIX = process.env.VNC_PREFIX || '/vnc'
const UPSTREAM = '127.0.0.1'

/**
 * Pick the upstream port and rewrite the path for one request URL.
 * @param {string} url Request target as received.
 * @returns {{ port: number, path: string }}
 */
function route(url) {
  if (url === '/resize' || url.startsWith('/resize?')) {
    return { port: SIDECAR_PORT, path: url }
  }
  if (url === VNC_PREFIX) return { port: NOVNC_PORT, path: '/' }
  if (url.startsWith(VNC_PREFIX + '/')) {
    return { port: NOVNC_PORT, path: url.slice(VNC_PREFIX.length) }
  }
  // noVNC builds its RFB WebSocket URL from the page's host and the `path`
  // setting, which defaults to a bare `websockify` at the origin root — the
  // /vnc prefix is not carried over. Route it explicitly rather than making
  // every caller pass ?path=vnc/websockify.
  if (url === '/websockify' || url.startsWith('/websockify?')) {
    return { port: NOVNC_PORT, path: url }
  }
  return { port: WEB_PORT, path: url }
}

const server = http.createServer((req, res) => {
  const { port, path } = route(req.url || '/')
  // Present the upstream with a loopback Host: dsh web treats non-loopback
  // authorities as LAN access and would otherwise reject the proxied request.
  // agent:false + Connection: close — one fresh upstream socket per request.
  // websockify serves noVNC's static files from python's http.server, which
  // closes connections on its own schedule; a pooled keep-alive socket gets
  // reset mid-flight under concurrency and surfaced as a sporadic 502.
  //
  // Host is forwarded verbatim on purpose. dsh web's /api browser-trust fence
  // requires an attached Origin to equal the Host authority, so rewriting Host
  // to loopback makes every browser POST fail the Origin check with a 403.
  // Declare the public authority with TRUSTED_HOSTS instead.
  const headers = { ...req.headers, connection: 'close' }
  const upstream = http.request(
    { host: UPSTREAM, port, path, method: req.method, headers, agent: false },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers)
      up.pipe(res)
    },
  )
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
    res.end('front-proxy: upstream unavailable\n')
  })
  req.pipe(upstream)
})

// Raw upgrade forwarding: replay the request line and headers on a plain
// socket, then let the two sockets talk to each other.
server.on('upgrade', (req, socket, head) => {
  const { port, path } = route(req.url || '/')
  // Host forwarded verbatim, same reason as the request path above: the
  // WebSocket handshake carries an Origin and passes the same fence.
  const headers = { ...req.headers }
  const upstream = net.connect(port, UPSTREAM, () => {
    const lines = [`${req.method} ${path} HTTP/1.1`]
    for (const [key, value] of Object.entries(headers)) {
      for (const one of Array.isArray(value) ? value : [value]) {
        lines.push(`${key}: ${one}`)
      }
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n')
    if (head && head.length) upstream.write(head)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  const drop = () => { socket.destroy(); upstream.destroy() }
  upstream.on('error', drop)
  socket.on('error', drop)
})

server.listen(FRONT_PORT, FRONT_BIND, () => {
  console.log(`[front-proxy] ${FRONT_BIND}:${FRONT_PORT}`
    + ` -> web:${WEB_PORT} ${VNC_PREFIX}:${NOVNC_PORT} /resize:${SIDECAR_PORT}`)
})
