/* The start page is a projection of the server state (0007: 服务端状态权威):
   it renders exactly what /api/state + /api/events carry and holds no
   business logic of its own. The entry auto-checks on arrival (a read-only
   reconcile); provisioning is the user's click on the check button, and the
   jump to the IDE is the user's click on the open button (requester
   decision, 2026-09-06). */
'use strict'

const statusEl = document.getElementById('status')
const logEl = document.getElementById('log')
const checkBtn = document.getElementById('check')
const openBtn = document.getElementById('open')
const retryBtn = document.getElementById('retry')

const LABELS = {
  PROVISIONING: '正在创建你的 IDE 容器…',
  STARTING: '正在启动容器并通过健康检查…',
  HEALTHY: '服务已就绪,点击“打开我的 IDE”进入。',
  READY: '服务已就绪!点击“打开我的 IDE”进入。',
  FAILED: '开通失败,见下方日志。',
  TIMEOUT: '健康检查超时,可重试。',
  IDLE: '服务处于闲置状态,正在唤醒…',
  UNHEALTHY: '服务异常,正在自动恢复…',
}

let seenSeq = 0
// The log is for operators in China: render Beijing time regardless of the
// browser's timezone (requester, 2026-09-06).
const logTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

function renderState(event) {
  const checking = checkBtn.disabled && event.state === 'NO_SERVICE'
  statusEl.textContent = checking ? '正在检查服务状态…' : (event.state === 'NO_SERVICE' ? '未发现运行中的 IDE,点击“检查并开通”创建。' : (LABELS[event.state] ?? event.state))
  statusEl.className = 'state ' + event.state.toLowerCase()
  if (event.ideUrl) openBtn.href = event.ideUrl
  openBtn.hidden = !(event.ideUrl && (event.state === 'READY' || event.state === 'HEALTHY'))
  checkBtn.hidden = event.state !== 'NO_SERVICE'
  if (event.state !== 'NO_SERVICE') checkBtn.disabled = false
  retryBtn.hidden = !(event.state === 'FAILED' || event.state === 'TIMEOUT')
}

function renderStep(step) {
  if (step.seq <= seenSeq) return
  seenSeq = step.seq
  const time = logTime.format(new Date(step.atMs))
  const line = document.createElement('div')
  line.className = 'step ' + step.status
  line.textContent = `[${time}] ${step.step} — ${step.detail}`
  logEl.appendChild(line)
  logEl.scrollTop = logEl.scrollHeight
}

function connect() {
  const source = new EventSource('/api/events')
  source.onmessage = (message) => {
    const event = JSON.parse(message.data)
    if (event.type === 'state') renderState(event)
    else renderStep(event)
    // Ready states stop at the status line; only the user's click on the
    // open button navigates (requester decision, 2026-09-06: no auto jump).
  }
  source.onerror = () => { /* EventSource reconnects on its own; the server replays on (re)connect. */ }
}

// The one action that reaches Jenkins: the user's own check button (FR3/FR4).
// A healthy answer lands as READY on the stream and reveals the open button;
// an absent or stopped service continues into provisioning under the same
// request.
checkBtn.addEventListener('click', async () => {
  checkBtn.disabled = true
  statusEl.textContent = '正在检查服务状态…'
  await fetch('/api/provision', { method: 'POST', credentials: 'same-origin' })
})
openBtn.addEventListener('click', () => { window.location.assign(openBtn.href) })
retryBtn.addEventListener('click', async () => {
  retryBtn.disabled = true
  await fetch('/api/retry', { method: 'POST', credentials: 'same-origin' })
  retryBtn.disabled = false
})

// Bootstrap from the authoritative snapshot (the entry already auto-checked:
// the state here is fresh and read-only), then stream (FR5, FR7 joiner view).
// Provisioning never starts on its own — the check button owns that click.
fetch('/api/state', { credentials: 'same-origin' })
  .then(async (response) => {
    const snapshot = await response.json()
    renderState(snapshot.state)
    for (const step of snapshot.steps) renderStep(step)
  })
  .catch(() => { statusEl.textContent = '无法读取状态,请刷新页面。' })
connect()
