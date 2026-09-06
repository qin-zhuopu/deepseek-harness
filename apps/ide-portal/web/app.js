/* The start page is a projection of the server state (0007: 服务端状态权威):
   it renders exactly what /api/state + /api/events carry and holds no
   business logic of its own. Three buttons, always visible (requester
   decision, 2026-09-06): 检查我的IDE re-runs the read-only probe;
   启动我的IDE starts idempotently (healthy short-circuits, an in-flight run
   is joined, only absent/stopped triggers create/start); 进入我的IDE jumps
   when the service is ready and logs a hint otherwise. Unmet preconditions
   land as a line in the log area, never as a hidden or disabled button. */
'use strict'

const statusEl = document.getElementById('status')
const logEl = document.getElementById('log')
const checkBtn = document.getElementById('check')
const startBtn = document.getElementById('provision')
const openBtn = document.getElementById('open')

const LABELS = {
  PROVISIONING: '正在创建你的 IDE 容器…',
  STARTING: '正在启动容器并通过健康检查…',
  HEALTHY: '服务已就绪,点击“进入我的IDE”。',
  READY: '服务已就绪!点击“进入我的IDE”。',
  FAILED: '启动失败,见下方日志;可再次点击“启动我的IDE”重试。',
  TIMEOUT: '健康检查超时;可再次点击“启动我的IDE”重试。',
  IDLE: '服务处于闲置状态,正在唤醒…',
  UNHEALTHY: '服务异常,点击“启动我的IDE”恢复。',
}

/** The latest state event; the jump pre-check reads it. */
let current = { state: 'NO_SERVICE', checking: false, ideUrl: undefined }
let seenSeq = 0
// The log is for operators in China: render Beijing time regardless of the
// browser's timezone (requester, 2026-09-06).
const logTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

function renderState(event) {
  current = event
  if (event.checking) {
    statusEl.textContent = '正在检查服务状态…'
    statusEl.className = 'state checking'
  } else {
    statusEl.textContent = event.state === 'NO_SERVICE' ? '尚未开通:点击“启动我的IDE”创建你的 IDE。' : (LABELS[event.state] ?? event.state)
    statusEl.className = 'state ' + event.state.toLowerCase()
  }
  if (event.ideUrl) openBtn.href = event.ideUrl
  // Buttons stay visible in every state; idempotence and the click-time
  // pre-checks own correctness, not visibility.
}

function renderStep(step) {
  if (step.seq <= seenSeq) return
  // 工号 opens every check chain: a second one means the server started a
  // new check (the per-check step-log reset) — drop the previous chain so
  // only the current one shows.
  if (step.step === '工号' && logEl.childElementCount > 0) logEl.textContent = ''
  seenSeq = step.seq
  const time = logTime.format(new Date(step.atMs))
  const line = document.createElement('div')
  line.className = 'step ' + step.status
  line.textContent = `[${time}] ${step.step} — ${step.detail}`
  logEl.appendChild(line)
  logEl.scrollTop = logEl.scrollHeight
}

/** A local hint line for an unmet click precondition (same shape as server steps). */
function hint(detail) {
  const line = document.createElement('div')
  line.className = 'step info'
  line.textContent = `[${logTime.format(new Date())}] 提示 — ${detail}`
  logEl.appendChild(line)
  logEl.scrollTop = logEl.scrollHeight
}

function connect() {
  const source = new EventSource('/api/events')
  source.onmessage = (message) => {
    const event = JSON.parse(message.data)
    if (event.type === 'state') renderState(event)
    else renderStep(event)
    // Ready states stop at the status line; only the user's click on
    // 进入我的IDE navigates (requester decision, 2026-09-06: no auto jump).
  }
  source.onerror = () => { /* EventSource reconnects on its own; the server replays on (re)connect. */ }
}

// 检查我的IDE re-runs the read-only arrival probe; the chain streams over
// SSE. A probe already in flight absorbs further clicks server-side.
checkBtn.addEventListener('click', async () => {
  statusEl.textContent = '正在检查服务状态…'
  await fetch('/api/check', { method: 'POST', credentials: 'same-origin' })
})
// 启动我的IDE is idempotent on the server; a second click while it runs
// joins the in-flight run instead of starting a duplicate.
startBtn.addEventListener('click', async () => {
  await fetch('/api/provision', { method: 'POST', credentials: 'same-origin' })
})
// 进入我的IDE jumps only on a settled ready state; anything earlier gets a
// hint naming the action that unblocks it.
openBtn.addEventListener('click', () => {
  const ready = !current.checking && (current.state === 'READY' || current.state === 'HEALTHY') && current.ideUrl
  if (ready) {
    window.location.assign(current.ideUrl)
    return
  }
  if (current.checking) hint('正在检查服务状态,请稍候再点击「进入我的IDE」。')
  else if (current.state === 'NO_SERVICE') hint('尚未开通——请先点击「启动我的IDE」。')
  else if (current.state === 'PROVISIONING' || current.state === 'STARTING') hint('正在启动,完成后即可「进入我的IDE」。')
  else hint('服务尚未就绪——请先点击「检查我的IDE」确认状态,必要时「启动我的IDE」。')
})

// Bootstrap from the authoritative snapshot, then stream (FR5, FR7 joiner
// view). The arrival check may still be in flight: its chain follows on SSE.
fetch('/api/state', { credentials: 'same-origin' })
  .then(async (response) => {
    const snapshot = await response.json()
    renderState(snapshot.state)
    for (const step of snapshot.steps) renderStep(step)
  })
  .catch(() => { statusEl.textContent = '无法读取状态,请刷新页面。' })
connect()
