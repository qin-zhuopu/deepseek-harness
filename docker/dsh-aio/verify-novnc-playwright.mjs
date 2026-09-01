// =====================================================================
// dsh-aio noVNC + clipboard-sync verification (Playwright driver)
//
// Usage (run from the REPO ROOT so Node resolves the workspace
// `playwright` dependency, which lives under apps/web):
//
//   node docker/dsh-aio/verify-novnc-playwright.mjs
//
// It targets an ALREADY-RUNNING dsh-aio container and proves the four
// facts the autocutsel clipboard-sync commit (c5cbc88c1d) plus the
// noVNC desktop stack depend on:
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
//
// Steps 1-3 (and the canvas paint check in step 4) are MANDATORY:
// any failure exits non-zero. An optional clipboard round-trip is a
// BONUS and degrades to SKIP if its helper tool (xdotool/xsel) is
// absent — it never hard-fails.
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

/** Load vnc.html and confirm the noVNC canvas paints. */
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
    return true
  } catch (err) {
    // Best-effort screenshot even on failure, for debugging evidence.
    try {
      await mkdir(LOG_DIR, { recursive: true })
      const pages = browser?.contexts().flatMap(c => c.pages()) ?? []
      if (pages[0]) await pages[0].screenshot({ path: SCREENSHOT, fullPage: true })
    } catch { /* ignore */ }
    record('noVNC canvas painted', false, `${url} -> ${err?.message ?? err}`)
    return false
  } finally {
    await browser?.close()
  }
}

/**
 * BONUS: clipboard round-trip inside the container. Non-fatal — degrades
 * to SKIP if no helper tool (xdotool / xsel) is present. Never fails the
 * overall run.
 */
async function checkClipboardRoundTrip() {
  const marker = `dsh-aio-verify-${Date.now()}`
  // Try xdotool, then xsel. `set -e` so a missing tool errors out and we SKIP.
  const script = [
    'set -e',
    'export DISPLAY=:99',
    `MARK='${marker}'`,
    'if command -v xsel >/dev/null 2>&1; then',
    '  printf "%s" "$MARK" | xsel -i -b',
    '  OUT="$(xsel -o -b)"',
    'elif command -v xdotool >/dev/null 2>&1; then',
    '  xdotool type --clearmodifiers "$MARK" >/dev/null 2>&1 || true',
    '  OUT=""',
    'else',
    '  echo "__NO_CLIPBOARD_TOOL__"; exit 42',
    'fi',
    'printf "ROUNDTRIP:%s" "$OUT"',
  ].join('\n')

  const { file, args } = containerExec('bash', ['-lc', script])
  try {
    const { stdout } = await execFileAsync(file, args)
    const echoed = /ROUNDTRIP:(.*)/.exec(stdout)?.[1]?.trim()
    if (echoed === marker) {
      record('clipboard round-trip (bonus)', true, `CLIPBOARD echoed marker via xsel`)
    } else {
      record('clipboard round-trip (bonus)', null, `set marker but could not read it back (tool limited); non-fatal`)
    }
  } catch (err) {
    const out = (err?.stdout ?? '') + (err?.stderr ?? '')
    if (/__NO_CLIPBOARD_TOOL__/.test(out) || err?.code === 42) {
      record('clipboard round-trip (bonus)', null, 'no xsel/xdotool in container; skipped')
    } else {
      record('clipboard round-trip (bonus)', null, `non-fatal error: ${err?.message ?? err}`)
    }
  }
}

async function main() {
  console.log('=== dsh-aio noVNC + clipboard verification ===')
  console.log(`DSH_URL=${DSH_URL}  NOVNC_URL=${NOVNC_URL}  CONTAINER=${CONTAINER}`)
  console.log('')

  // Mandatory checks (steps 1-3 + canvas paint).
  const dshOk = await checkHttp200('dsh web HTTP 200', `${DSH_URL}/`)
  const novncHttpOk = await checkHttp200('noVNC vnc.html HTTP 200', `${NOVNC_URL}/vnc.html`)
  const autocutselOk = await checkAutocutsel()
  const canvasOk = await checkNovncCanvas()

  // Bonus (non-fatal).
  await checkClipboardRoundTrip()

  const mandatory = { dshOk, novncHttpOk, autocutselOk, canvasOk }
  const allPass = Object.values(mandatory).every(Boolean)

  console.log('')
  console.log('----------------------------------------')
  if (allPass) {
    console.log('RESULT: ✅ PASS — dsh web + noVNC serve, both autocutsel instances run, noVNC canvas painted.')
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
