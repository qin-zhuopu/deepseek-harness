/* The start page is a projection of the server state (0007: 服务端状态权威):
   it renders exactly what /api/state + /api/events carry and holds no
   business logic of its own. The entry mode is a deployment choice carried by
   /api/state: with autoCheck the entry already reconciled and the page
   auto-starts a cold run; without it nothing reaches Jenkins until the user
   presses the check button (0007 FR3/FR4). */
'use strict'

const statusEl = document.getElementById('status')
const logEl = document.getElementById('log')
const checkBtn = document.getElementById('check')
const openBtn = document.getElementById('open')
const retryBtn = document.getElementById('retry')

const LABELS = {
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
// The entry mode from the /api/state snapshot; auto until stated otherwise,
// so the check button never flashes in an autoCheck deployment.
let autoCheck = true

function noServiceLabel() {
  return autoCheck ? '正在检查服务状态…' : '尚未检查服务状态,点击按钮开始。'
}

function renderState(event) {
  const checking = checkBtn.disabled && event.state === 'NO_SERVICE'
  statusEl.textContent = checking ? '正在检查服务状态…' : (event.state === 'NO_SERVICE' ? noServiceLabel() : (LABELS[event.state] ?? event.state))
  statusEl.className = 'state ' + event.state.toLowerCase()
  if (event.ideUrl) openBtn.href = event.ideUrl
  openBtn.hidden = !(event.ideUrl && event.state === 'READY')
  checkBtn.hidden = autoCheck || event.state !== 'NO_SERVICE'
  if (event.state !== 'NO_SERVICE') checkBtn.disabled = false
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

// The one action that reaches Jenkins: the user's own check button (FR3/FR4).
// A healthy answer lands as READY on the stream (auto-navigation); an absent
// or stopped service continues into provisioning under the same request.
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

// Bootstrap from the authoritative snapshot, then stream (FR5, FR7 joiner view).
fetch('/api/state', { credentials: 'same-origin' })
  .then(async (response) => {
    const snapshot = await response.json()
    autoCheck = snapshot.autoCheck === true
    renderState(snapshot.state)
    for (const step of snapshot.steps) renderStep(step)
    // The portal already observed this service through a health check: finish
    // the hand-off exactly as the live stream would (FR7 joiner view).
    if ((snapshot.state.state === 'READY' || snapshot.state.state === 'HEALTHY') && snapshot.state.ideUrl) window.location.assign(snapshot.state.ideUrl)
    // Auto mode keeps the entry flow: the entry reconciled before rendering, so
    // a run the entry did not already start begins here, including reconcile-
    // found stopped containers (FR6); /api/provision joins in-flight runs (FR7).
    // Manual mode waits for the check button and starts nothing here.
    const driven = snapshot.steps.some(step => step.step !== 'reconcile')
    if (autoCheck && !driven && ['NO_SERVICE', 'STARTING', 'IDLE', 'UNHEALTHY'].includes(snapshot.state.state)) void fetch('/api/provision', { method: 'POST', credentials: 'same-origin' })
  })
  .catch(() => { statusEl.textContent = '无法读取状态,请刷新页面。' })
connect()
