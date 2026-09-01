// =====================================================================
// dsh-aio noVNC + clipboard-sync verification (Playwright driver)
//
// Usage (run from the REPO ROOT so Node resolves the workspace
// `playwright` dependency, which lives under apps/web):
//
//   node docker/dsh-aio/verify-novnc-playwright.mjs
//
// It targets an ALREADY-RUNNING dsh-aio container and proves the five
// facts the autocutsel clipboard-sync commit plus the noVNC desktop
// stack depend on. ALL of them are MANDATORY — any failure exits
// non-zero:
//
//   1) dsh web answers HTTP 200 on ${DSH_URL}/            (default :3080)
//   2) noVNC serves ${NOVNC_URL}/vnc.html   HTTP 200      (default :6080)
//   3) BOTH autocutsel instances are alive inside the container:
//        `docker exec ${CONTAINER} pgrep -a autocutsel`
//      must show `-selection CLIPBOARD` AND `-selection PRIMARY`
//      (the two selections entrypoint.sh forks). This is the specific
//      verification of the autocutsel commit under test.
//   4) Playwright (headless chromium, --no-sandbox) loads
//        ${NOVNC_URL}/vnc.html?autoconnect=true&resize=scale
//      and the noVNC <canvas> appears and PAINTS (non-zero width and
//      height) — i.e. the RFB session connected to the desktop. A
//      screenshot is saved to docker/dsh-aio/logs/novnc-verify.png.
//   5) The clipboard actually SYNCS in BOTH directions ACROSS THE noVNC/RFB
//      BROWSER CHANNEL — this is the question the user asked ("can the VNC
//      browser share the clipboard?"), so the browser/RFB leg is the ONLY
//      thing that satisfies this mandatory check. This uses xsel on
//      DISPLAY=:99 together with the live noVNC page:
//        • REMOTE->LOCAL: a unique marker is pushed into the X CLIPBOARD
//          with `xsel -i -b`; the running noVNC page must observe that
//          exact text on the RFB clipboard side (noVNC clipboard panel
//          textarea #noVNC_clipboard_text, fed by the RFB 'clipboard'
//          event). Proven-via = "browser".
//        • LOCAL->REMOTE: a second unique marker is pushed from the
//          noVNC clipboard panel toward the server (RFB.clipboardPasteFrom).
//          To prove the paste actually CROSSED the RFB channel (not merely
//          that the panel DOM exists), the container CLIPBOARD is CLEARED to
//          a sentinel BEFORE the push and `xsel -o -b` must then read back
//          the exact marker. Proven-via = "browser".
//      This leg is MANDATORY and browser-only: it FAILS LOUDLY (non-zero
//      exit) if the marker does not cross the RFB channel in BOTH directions.
//      It NEVER passes on autocutsel process-presence alone, and NEVER passes
//      on the X-layer autocutsel bridge alone.
//
//      The X-layer autocutsel bridge (CLIPBOARD<->PRIMARY<->cut buffer,
//      entirely inside X with no browser involvement) is exercised only as a
//      SECONDARY diagnostic, recorded as a separate non-mandatory line tagged
//      "x-bridge". A bridge-only result can NEVER read as a browser-proven
//      pass: it does not contribute to remoteOk/localOk and does not flip the
//      mandatory clipboard check. The concrete marker strings observed on each
//      side, and the per-direction proven-via tag, are logged as evidence.
//
// Environment knobs:
//   NOVNC_URL   noVNC base URL   (default http://localhost:6080)
//   DSH_URL     dsh web base URL (default http://localhost:3080)
//   CONTAINER   container name   (default dsh-aio)
//
// Prerequisites: a running dsh-aio container with 6080/3080 reachable
// from the host (use --network host, or -p 6080:6080 -p 3080:3080 with
// BIND_ADDR=0.0.0.0), and the repo's `playwright` dependency installed.
//
// Exit code: 0 only if all mandatory checks pass; non-zero otherwise.
// A clear final PASS/FAIL summary line is always printed.
// =====================================================================

import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { chromium } from 'playwright'

const execFileAsync = promisify(execFile)

const NOVNC_URL = (process.env.NOVNC_URL ?? 'http://localhost:6080').replace(/\/+$/, '')
const DSH_URL = (process.env.DSH_URL ?? 'http://localhost:3080').replace(/\/+$/, '')
const CONTAINER = process.env.CONTAINER ?? 'dsh-aio'

// The `__inproc__` sentinel means "run container-side commands LOCALLY,
// not via `docker exec`", used when this script itself runs INSIDE the
// dsh-aio container (where no `docker` binary exists), which is necessary
// because rootless-podman's network namespace hides the container's
// loopback ports from the host, so checks must target 127.0.0.1 from
// inside the container.
const INPROC = CONTAINER === '__inproc__'

/**
 * Build the argv for running `cmd argv...` either inside the container
 * (default: `docker exec ${CONTAINER} cmd argv...`) or locally when the
 * `__inproc__` sentinel is set (run `cmd argv...` directly). Shared by
 * the autocutsel check and the clipboard round-trip so both agree on how
 * container-side commands are dispatched.
 */
function containerExec(cmd, argv) {
  return INPROC ? { file: cmd, args: argv } : { file: 'docker', args: ['exec', CONTAINER, cmd, ...argv] }
}

const HERE = dirname(fileURLToPath(import.meta.url))
const LOG_DIR = join(HERE, 'logs')
const SCREENSHOT = join(LOG_DIR, 'novnc-verify.png')

const CANVAS_TIMEOUT_MS = 45_000

/** Collected results for the final summary. `null` == skipped/non-fatal. */
const results = []

function record(name, ok, detail) {
  results.push({ name, ok, detail })
  const tag = ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL'
  console.log(`[${tag}] ${name}${detail ? ` — ${detail}` : ''}`)
}

/** HTTP 200 assertion via node fetch. */
async function checkHttp200(name, url) {
  try {
    const res = await fetch(url, { redirect: 'follow' })
    const ok = res.status === 200
    record(name, ok, `${url} -> HTTP ${res.status}`)
    return ok
  } catch (err) {
    record(name, false, `${url} -> ${err?.message ?? err}`)
    return false
  }
}

/** Both autocutsel instances present via `docker exec pgrep`. */
async function checkAutocutsel() {
  let out = ''
  const { file, args } = containerExec('pgrep', ['-a', 'autocutsel'])
  try {
    const { stdout } = await execFileAsync(file, args)
    out = stdout
  } catch (err) {
    // pgrep exits 1 when nothing matches; surface whatever it printed.
    out = (err?.stdout ?? '') + (err?.stderr ?? '')
    if (!out.trim()) {
      record('autocutsel CLIPBOARD + PRIMARY running', false, `${INPROC ? 'pgrep' : 'docker exec'} failed: ${err?.message ?? err}`)
      return false
    }
  }
  const hasClipboard = /-selection\s+CLIPBOARD/.test(out)
  const hasPrimary = /-selection\s+PRIMARY/.test(out)
  const ok = hasClipboard && hasPrimary
  const detail = ok
    ? 'both instances found'
    : `CLIPBOARD=${hasClipboard} PRIMARY=${hasPrimary}; pgrep output:\n${out.trim()}`
  record('autocutsel CLIPBOARD + PRIMARY running', ok, detail)
  return ok
}

/**
 * Load vnc.html, confirm the noVNC canvas paints, and hand back the live
 * page/browser so the clipboard legs can drive the SAME RFB session.
 * Records the canvas result. On failure the browser is closed here and
 * `page`/`browser` come back null so the caller can still run the X-layer
 * clipboard fallback.
 */
async function checkNovncCanvas() {
  const url = `${NOVNC_URL}/vnc.html?autoconnect=true&resize=scale`
  let browser
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
    const page = await browser.newPage()
    await page.goto(url, { waitUntil: 'load', timeout: CANVAS_TIMEOUT_MS })

    // Poll for a <canvas> (noVNC renders into a canvas inside #screen /
    // .noVNC_canvas) with a painted, non-zero size — proof the RFB
    // session connected and drew the desktop.
    const size = await page.waitForFunction(
      () => {
        const canvas = document.querySelector('#screen canvas, canvas.noVNC_canvas, #noVNC_canvas, canvas')
        if (!canvas) return null
        const w = canvas.width || canvas.clientWidth
        const h = canvas.height || canvas.clientHeight
        return w > 0 && h > 0 ? { w, h } : null
      },
      { timeout: CANVAS_TIMEOUT_MS, polling: 500 },
    ).then(handle => handle.jsonValue())

    await mkdir(LOG_DIR, { recursive: true })
    await page.screenshot({ path: SCREENSHOT, fullPage: true })
    record('noVNC canvas painted', true, `canvas ${size.w}x${size.h}; screenshot -> ${SCREENSHOT}`)
    return { ok: true, browser, page }
  } catch (err) {
    // Best-effort screenshot even on failure, for debugging evidence.
    try {
      await mkdir(LOG_DIR, { recursive: true })
      const pages = browser?.contexts().flatMap(c => c.pages()) ?? []
      if (pages[0]) await pages[0].screenshot({ path: SCREENSHOT, fullPage: true })
    } catch { /* ignore */ }
    record('noVNC canvas painted', false, `${url} -> ${err?.message ?? err}`)
    await browser?.close()
    return { ok: false, browser: null, page: null }
  }
}

/** Run a shell snippet container-side (docker exec or __inproc__ local). */
async function containerBash(script) {
  const { file, args } = containerExec('bash', ['-lc', script])
  return execFileAsync(file, args)
}

/** Write text into the container X CLIPBOARD selection on DISPLAY=:99. */
async function xselWriteClipboard(text) {
  // printf on stdin so the marker is never word-split or shell-expanded.
  await containerBash(`printf %s ${shellSingleQuote(text)} | DISPLAY=:99 xsel -i -b`)
}

/** Read the container X CLIPBOARD selection on DISPLAY=:99. */
async function xselReadClipboard() {
  const { stdout } = await containerBash('DISPLAY=:99 xsel -o -b')
  return stdout
}

/** Single-quote a value for safe embedding in a bash -lc script. */
function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** Poll the noVNC clipboard panel textarea for received server clipboard text. */
async function readNovncClipboardText(page) {
  return page.evaluate(() => {
    const el = document.querySelector('#noVNC_clipboard_text')
    return el ? el.value : null
  })
}

/**
 * Push text toward the RFB server through the noVNC clipboard panel:
 * open the panel, set the textarea, and dispatch the `change` event
 * noVNC listens for (its handler calls RFB.clipboardPasteFrom).
 * Returns true if the panel elements were present and driven. A true here
 * only means the DOM was driven; it is NOT proof the paste crossed the RFB
 * channel — the caller confirms that with a container-side xsel readback
 * against a pre-cleared CLIPBOARD.
 */
async function pushNovncClipboardText(page, text) {
  return page.evaluate(marker => {
    const btn = document.querySelector('#noVNC_clipboard_button')
    const ta = document.querySelector('#noVNC_clipboard_text')
    if (!ta) return false
    if (btn) btn.click() // open the clipboard panel so the handler is wired
    ta.value = marker
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }, text)
}

/** Overwrite the container X CLIPBOARD with a sentinel so a stale value can
 * never be mistaken for a fresh cross-channel readback. */
async function xselClearClipboard(sentinel) {
  await containerBash(`printf %s ${shellSingleQuote(sentinel)} | DISPLAY=:99 xsel -i -b`)
}

/**
 * Read the X-layer autocutsel bridge state as a SECONDARY diagnostic: after a
 * marker is placed on CLIPBOARD, autocutsel mirrors it into PRIMARY and the
 * raw cut buffer entirely inside X, with no browser/RFB involvement. Returns
 * whether the marker reached a far-side X selection, for a strictly-labelled
 * "x-bridge" diagnostic line that NEVER satisfies the browser clipboard claim.
 */
async function probeXBridge(marker) {
  const script = [
    'export DISPLAY=:99',
    'sleep 1', // autocutsel mirrors CLIPBOARD<->cutbuffer<->PRIMARY; give it a moment.
    'PRIMARY="$(xsel -o -p 2>/dev/null || true)"',
    'CUT="$(xsel -o 2>/dev/null || true)"',
    'printf "PRIMARY:%s\\nCUT:%s\\n" "$PRIMARY" "$CUT"',
  ].join('\n')
  const { stdout } = await containerBash(script)
  const primary = /PRIMARY:(.*)/.exec(stdout)?.[1]?.trim()
  const cut = /CUT:(.*)/.exec(stdout)?.[1]?.trim()
  return { moved: primary === marker || cut === marker, primary, cut }
}

/**
 * MANDATORY bidirectional clipboard round-trip ACROSS THE noVNC/RFB BROWSER
 * CHANNEL. This is the direct answer to "can the VNC browser share the
 * clipboard?", so ONLY the browser/RFB leg satisfies it. Fails loudly (records
 * a FAIL that drives process.exit(1)) unless BOTH directions cross the RFB
 * channel. It never passes on autocutsel process-presence and never passes on
 * the X-layer autocutsel bridge alone.
 *
 * REMOTE->LOCAL (browser): set a unique marker into the X CLIPBOARD with
 * `xsel -i -b`; the noVNC page must surface it in #noVNC_clipboard_text (fed
 * by the RFB 'clipboard' event). provenVia = "browser".
 *
 * LOCAL->REMOTE (browser): CLEAR the container CLIPBOARD to a sentinel, push a
 * second unique marker from the noVNC clipboard panel toward the server
 * (RFB.clipboardPasteFrom), then read `xsel -o -b`. The readback must equal
 * the marker — proving the paste crossed the RFB channel rather than inferring
 * success from the panel DOM being present. provenVia = "browser".
 *
 * The X-layer autocutsel bridge is probed separately as a non-mandatory
 * diagnostic and reported on its own line tagged "x-bridge"; it does NOT
 * contribute to the returned boolean.
 *
 * @param {import('playwright').Page | null} page live noVNC page, or null if
 *        the canvas leg failed (then the browser leg cannot run and this check
 *        FAILS — the browser is the mandatory criterion).
 * @returns {Promise<boolean>} true only if BOTH directions crossed the RFB
 *        browser channel.
 */
async function checkClipboardRoundTrip(page) {
  const stamp = Date.now()
  const remoteMarker = `dsh-aio-remote-${stamp}`
  const localMarker = `dsh-aio-local-${stamp}`
  const sentinel = `dsh-aio-sentinel-${stamp}`
  // Per-direction proof tag: 'browser' (RFB channel) or null (not proven).
  let remoteVia = null
  let localVia = null
  // Secondary X-bridge diagnostics, reported separately, never mandatory.
  let xBridgeRemote = null
  let xBridgeLocal = null
  const evidence = []

  // ---- REMOTE -> LOCAL (container X CLIPBOARD -> noVNC/RFB browser) ----
  try {
    await xselWriteClipboard(remoteMarker)
    evidence.push(`X CLIPBOARD set to "${remoteMarker}"`)

    // MANDATORY browser leg: the noVNC page received it on the RFB channel.
    if (page) {
      let observed = null
      for (let i = 0; i < 40 && observed !== remoteMarker; i++) {
        observed = (await readNovncClipboardText(page))?.trim() ?? null
        if (observed === remoteMarker) break
        await new Promise(r => setTimeout(r, 500))
      }
      if (observed === remoteMarker) {
        remoteVia = 'browser'
        evidence.push(`[browser] noVNC #noVNC_clipboard_text observed "${observed}"`)
      } else {
        evidence.push(`[browser] noVNC clipboard panel did not surface the marker (saw ${JSON.stringify(observed)})`)
      }
    } else {
      evidence.push('[browser] REMOTE->LOCAL skipped: no live noVNC page (canvas leg failed)')
    }

    // SECONDARY diagnostic only: did autocutsel mirror CLIPBOARD into the
    // far-side X selections? This is the X-layer bridge, NOT the browser, and
    // never satisfies the mandatory browser clipboard claim.
    const bridge = await probeXBridge(remoteMarker)
    xBridgeRemote = bridge.moved
    evidence.push(`[x-bridge] PRIMARY=${JSON.stringify(bridge.primary)} CUT=${JSON.stringify(bridge.cut)} moved=${bridge.moved}`)
  } catch (err) {
    evidence.push(`REMOTE->LOCAL error: ${err?.message ?? err}`)
  }

  // ---- LOCAL -> REMOTE (noVNC/RFB browser -> container X CLIPBOARD) ----
  try {
    if (page) {
      // Clear CLIPBOARD to a sentinel first, so a positive readback can ONLY
      // come from the RFB paste actually crossing the channel, not a stale or
      // bridge-mirrored value left from the REMOTE->LOCAL leg.
      await xselClearClipboard(sentinel)
      const driven = await pushNovncClipboardText(page, localMarker)
      evidence.push(driven
        ? `[browser] noVNC clipboard panel pushed "${localMarker}" (CLIPBOARD pre-cleared to sentinel)`
        : '[browser] noVNC clipboard panel not present')
      if (driven) {
        let readback = null
        for (let i = 0; i < 40 && readback !== localMarker; i++) {
          readback = (await xselReadClipboard())?.trim() ?? null
          if (readback === localMarker) break
          await new Promise(r => setTimeout(r, 500))
        }
        evidence.push(`[browser] container xsel -o -b read ${JSON.stringify(readback)}`)
        if (readback === localMarker) {
          localVia = 'browser'
        }
      }
    } else {
      evidence.push('[browser] LOCAL->REMOTE skipped: no live noVNC page (canvas leg failed)')
    }

    // SECONDARY diagnostic only: seed PRIMARY and confirm autocutsel mirrors
    // it into CLIPBOARD entirely inside X. Tagged x-bridge; never mandatory.
    const bridgeMarker = `${localMarker}-xb`
    await containerBash(`printf %s ${shellSingleQuote(bridgeMarker)} | DISPLAY=:99 xsel -i -p`)
    let bridgeReadback = null
    for (let i = 0; i < 10 && bridgeReadback !== bridgeMarker; i++) {
      bridgeReadback = (await xselReadClipboard())?.trim() ?? null
      if (bridgeReadback === bridgeMarker) break
      await new Promise(r => setTimeout(r, 300))
    }
    xBridgeLocal = bridgeReadback === bridgeMarker
    evidence.push(`[x-bridge] PRIMARY->CLIPBOARD mirror read ${JSON.stringify(bridgeReadback)} moved=${xBridgeLocal}`)
  } catch (err) {
    evidence.push(`LOCAL->REMOTE error: ${err?.message ?? err}`)
  }

  const remoteOk = remoteVia === 'browser'
  const localOk = localVia === 'browser'
  const ok = remoteOk && localOk
  const summary = ok
    ? 'both directions proven across the RFB browser channel'
    : `REMOTE->LOCAL via=${remoteVia ?? 'none'} LOCAL->REMOTE via=${localVia ?? 'none'}` +
      ` (X-bridge diagnostic: remote=${xBridgeRemote} local=${xBridgeLocal}; the X-bridge does NOT satisfy the browser clipboard requirement)`
  const detail = `${summary}; proven-via: REMOTE->LOCAL=${remoteVia ?? 'none'}, LOCAL->REMOTE=${localVia ?? 'none'}; evidence: ${evidence.join(' | ')}`
  record('clipboard round-trip (bidirectional, browser/RFB leg)', ok, detail)
  return ok
}

async function main() {
  console.log('=== dsh-aio noVNC + clipboard verification ===')
  console.log(`DSH_URL=${DSH_URL}  NOVNC_URL=${NOVNC_URL}  CONTAINER=${CONTAINER}`)
  console.log('')

  // Mandatory checks (steps 1-3 + canvas paint + bidirectional clipboard).
  const dshOk = await checkHttp200('dsh web HTTP 200', `${DSH_URL}/`)
  const novncHttpOk = await checkHttp200('noVNC vnc.html HTTP 200', `${NOVNC_URL}/vnc.html`)
  const autocutselOk = await checkAutocutsel()
  const canvas = await checkNovncCanvas()
  let clipboardOk = false
  try {
    // The clipboard round-trip requires the live noVNC page: the browser/RFB
    // leg is the mandatory criterion. Without a page it cannot pass.
    clipboardOk = await checkClipboardRoundTrip(canvas.page)
  } finally {
    await canvas.browser?.close()
  }

  const mandatory = { dshOk, novncHttpOk, autocutselOk, canvasOk: canvas.ok, clipboardOk }
  const allPass = Object.values(mandatory).every(Boolean)

  console.log('')
  console.log('----------------------------------------')
  if (allPass) {
    console.log('RESULT: ✅ PASS — dsh web + noVNC serve, both autocutsel instances run, noVNC canvas painted, clipboard syncs both ways ACROSS THE noVNC/RFB BROWSER CHANNEL (proven per-direction, not via the X-layer bridge).')
  } else {
    const failed = Object.entries(mandatory).filter(([, ok]) => !ok).map(([k]) => k)
    console.log(`RESULT: ❌ FAIL — failing mandatory checks: ${failed.join(', ')}`)
  }
  console.log('----------------------------------------')

  process.exit(allPass ? 0 : 1)
}

main().catch(err => {
  console.error(`RESULT: ❌ FAIL — unexpected error: ${err?.stack ?? err}`)
  process.exit(1)
})
