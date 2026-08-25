#!/usr/bin/env node
// Navigate the container's existing Chrome tab to a URL over CDP.
//
// Why not curl: the HTTP endpoint can list targets but cannot drive them —
// Page.navigate is only reachable over the target's WebSocket. And /json/new
// would open an additional tab, leaving the original about:blank behind; this
// reuses the first page target instead, so the desktop keeps one window.
//
// Zero dependencies (a raw RFC 6455 client over node:net) because the image
// has no ws package and this runs before anything installs one.
'use strict'

const crypto = require('node:crypto')
const http = require('node:http')
const net = require('node:net')

const URL_TO_OPEN = process.argv[2]
const CDP_HOST = process.env.BIND_ADDR || '127.0.0.1'
const CDP_PORT = Number(process.env.CDP_PORT || 9222)

if (!URL_TO_OPEN) {
  console.error('usage: cdp-navigate.js <url>')
  process.exit(2)
}

/** GET a CDP HTTP endpoint and parse the JSON body. */
function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: CDP_HOST, port: CDP_PORT, path }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('CDP HTTP timeout')))
  })
}

/**
 * Send one CDP command over a target's WebSocket and resolve when its reply
 * arrives. The connection is single-use, so the frame handling only needs to
 * cover what one small text reply requires.
 * @param {string} wsUrl Target's webSocketDebuggerUrl.
 * @param {object} message CDP command including its id.
 */
function sendCommand(wsUrl, message) {
  return new Promise((resolve, reject) => {
    const { hostname, port, pathname } = new URL(wsUrl)
    const key = crypto.randomBytes(16).toString('base64')
    const socket = net.connect(Number(port), hostname, () => {
      socket.write(
        `GET ${pathname} HTTP/1.1\r\n`
        + `Host: ${hostname}:${port}\r\n`
        + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
        + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      )
    })

    const fail = (error) => { socket.destroy(); reject(error) }
    socket.setTimeout(10000, () => fail(new Error('CDP WebSocket timeout')))
    socket.on('error', fail)

    let handshakeDone = false
    let buffer = Buffer.alloc(0)

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (!handshakeDone) {
        const end = buffer.indexOf('\r\n\r\n')
        if (end === -1) return
        const head = buffer.subarray(0, end).toString('latin1')
        if (!/^HTTP\/1\.1 101/.test(head)) return fail(new Error(`CDP upgrade refused: ${head.split('\r\n')[0]}`))
        handshakeDone = true
        buffer = buffer.subarray(end + 4)
        // Client frames must be masked (RFC 6455 5.3).
        const payload = Buffer.from(JSON.stringify(message))
        const mask = crypto.randomBytes(4)
        const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]))
        const header = payload.length < 126
          ? Buffer.from([0x81, 0x80 | payload.length])
          : Buffer.concat([Buffer.from([0x81, 0xfe]), (() => {
            const len = Buffer.alloc(2); len.writeUInt16BE(payload.length); return len
          })()])
        socket.write(Buffer.concat([header, mask, masked]))
      }

      // Server frames are unmasked; read just enough to find one text payload.
      while (buffer.length >= 2) {
        const length = buffer[1] & 0x7f
        let offset = 2
        let size = length
        if (length === 126) { size = buffer.readUInt16BE(2); offset = 4 } else if (length === 127) { size = Number(buffer.readBigUInt64BE(2)); offset = 10 }
        if (buffer.length < offset + size) return
        const frame = buffer.subarray(offset, offset + size).toString('utf8')
        buffer = buffer.subarray(offset + size)
        let reply
        try { reply = JSON.parse(frame) } catch { continue }
        if (reply.id !== message.id) continue
        socket.destroy()
        if (reply.error) return reject(new Error(`CDP error: ${JSON.stringify(reply.error)}`))
        return resolve(reply.result)
      }
    })
  })
}

// An async main, not top-level await: this file is CommonJS (require), where
// top-level await is a syntax error.
async function main() {
  const targets = await getJson('/json/list')
  const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
  if (page === undefined) throw new Error('no page target with a WebSocket URL')

  await sendCommand(page.webSocketDebuggerUrl, {
    id: 1,
    method: 'Page.navigate',
    params: { url: URL_TO_OPEN },
  })
  console.log(`navigated ${page.id} -> ${URL_TO_OPEN}`)
}

main().catch((error) => {
  console.error(String(error && error.message ? error.message : error))
  process.exit(1)
})
