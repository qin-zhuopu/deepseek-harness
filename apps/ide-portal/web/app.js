/* The start page is a projection of the server state (0007: 服务端状态权威):
   it renders exactly what /api/state + /api/events carry and holds no
   business logic of its own. */
'use strict'

const statusEl = document.getElementById('status')
const logEl = document.getElementById('log')
const openBtn = document.getElementById('open')
const retryBtn = document.getElementById('retry')

const LABELS = {
  NO_SERVICE: '正在检查服务状态…',
  PROVISIONING: '正在创建你的 IDE 容器…',
  STARTING: '正在启动容器并通过健康检查…',
  HEALTHY: '服务已就绪,正在进入…',
  READY: '服务已就绪!',
  FAILED: '开通失败,见下方日志。',
  TIMEOUT: '健康检查超时,可重试。',
  IDLE: '服务处于闲置状态,正在唤醒…',
  UNHEALTHY: '服务异常,正在自动恢复…',
}

let seenSeq = 0

function renderState(event) {
  statusEl.textContent = LABELS[event.state] ?? event.state
  statusEl.className = 'state ' + event.state.toLowerCase()
  if (event.ideUrl) openBtn.href = event.ideUrl
  openBtn.hidden = !(event.ideUrl && event.state === 'READY')
  retryBtn.hidden = !(event.state === 'FAILED' || event.state === 'TIMEOUT')
}

function renderStep(step) {
  if (step.seq <= seenSeq) return
  seenSeq = step.seq
  const time = new Date(step.atMs).toLocaleTimeString()
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
    if (event.type === 'state' && (event.state === 'READY' || event.state === 'HEALTHY') && event.ideUrl) {
      // Auto-navigation with the persistent button as the no-JS fallback (0008 Live log).
      window.location.assign(event.ideUrl)
    }
  }
  source.onerror = () => { /* EventSource reconnects on its own; the server replays on (re)connect. */ }
}

openBtn.addEventListener('click', () => { window.location.assign(openBtn.href) })
retryBtn.addEventListener('click', async () => {
  retryBtn.disabled = true
  await fetch('/api/retry', { method: 'POST', credentials: 'same-origin' })
  retryBtn.disabled = false
})

// Bootstrap from the authoritative snapshot, then stream (FR5, FR7 joiner view).
fetch('/api/state', { credentials: 'same-origin' })
  .then((response) => response.json())
  .then((snapshot) => {
    renderState(snapshot.state)
    for (const step of snapshot.steps) renderStep(step)
    // First view of a service that was never created: start the run now (FR4). An in-flight or failed run is joined or retried through the buttons, never re-triggered silently.
    if (snapshot.state.state === 'NO_SERVICE') void fetch('/api/provision', { method: 'POST', credentials: 'same-origin' })
  })
  .catch(() => { statusEl.textContent = '无法读取状态,请刷新页面。' })
connect()
