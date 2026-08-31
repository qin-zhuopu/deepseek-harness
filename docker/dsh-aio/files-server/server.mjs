#!/usr/bin/env node
// A tiny web file browser used by the DSH GUI "文件" tab. Serves a read-only
// directory browser rooted at ROOT (default /workspaces). No write support.
//
// Routes:
//   GET /            -> the file-browser page (index.html)
//   GET /api?path=<abs-or-relative> -> JSON directory listing
//
// The JSON API only lists directories below ROOT and never writes. Start with:
//   node /workspaces/system-admin/files-server/server.mjs --port 6099
import { createServer } from 'node:http'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

const ROOT = process.env.FILES_SERVER_ROOT || '/'
// Directory shown on first open (must be under ROOT/==/ so the visitor can
// still browse the whole tree from there).
const START = process.env.FILES_SERVER_START || '/root'
const PORT = Number(process.env.FILES_SERVER_PORT || 6099)
const HOST = process.env.FILES_SERVER_HOST || '127.0.0.1'

const INDEX_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>文件浏览器</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  background:#1e1e1e;color:#e8e8e8}
header{position:sticky;top:0;background:#262626;border-bottom:1px solid #3a3a3a;
  padding:10px 16px;display:flex;align-items:center;gap:8px}
header h1{font-size:15px;margin:0;flex:none;font-weight:600}
header .path{flex:1;margin:0;font-family:ui-monospace,Menlo,Consolas,monospace;
  font-size:13px;color:#9cdcfe;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}
header .up{margin-right:8px}
button.up{background:#3a6ea5;border:none;color:#fff;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:13px}
ul{list-style:none;margin:0;padding:0}
li{display:flex;align-items:center;gap:10px;padding:7px 16px;border-bottom:1px solid #2c2c2c;cursor:default}
li:hover{background:#2b2b2b}
li.dir{font-weight:500}
.icon{flex:none;width:20px;text-align:center;user-select:none}
li a{color:inherit;text-decoration:none;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
li a:hover{color:#7aa2ff}
.size{flex:none;color:#9a9a9a;font-size:12px;margin-left:auto;padding-left:16px}
.empty{padding:24px 16px;color:#9a9a9a;text-align:center}
</style>
</head>
<body>
<header>
  <h1>文件浏览器</h1>
  <span class="path" id="path"></span>
  <button class="up" id="up" style="display:none">上一级</button>
</header>
<ul id="list"></ul>
<script>
const ROOT = ${JSON.stringify(ROOT)}
const START = ${JSON.stringify(START)}
let current = '/'
function encodePath(p){ return encodeURIComponent(p) }
async function load(dir){
  current = dir || '/'
  const res = await fetch('api?path=' + encodePath(current))
  if(!res.ok){ document.getElementById('list').innerHTML='<li class="empty">无法读取目录</li>'; return }
  const data = await res.json()
  document.getElementById('path').textContent = data.path
  document.getElementById('up').style.display = data.parent ? '' : 'none'
  const ul = document.getElementById('list')
  ul.innerHTML=''
  for(const c of data.children){
    const li=document.createElement('li') ; if(c.dir) li.className='dir'
    const ic=document.createElement('span'); ic.className='icon'; ic.textContent=c.dir?'📁':'📄'
    const a=document.createElement('a'); a.textContent=c.name; a.href='#'
    a.addEventListener('click',(e)=>{e.preventDefault(); if(c.dir){ load(c.path) } else { window.open('raw?path='+encodePath(c.path),'_blank') }})
    li.appendChild(ic); li.appendChild(a)
    if(!c.dir){ const s=document.createElement('span'); s.className='size'; s.textContent=c.size; li.appendChild(s) }
    ul.appendChild(li)
  }
  if(!data.children.length) ul.innerHTML='<li class="empty">（空目录）</li>'
}
document.getElementById('up').addEventListener('click',async()=>{ const res=await fetch('api?path='+encodePath(current)); const d=await res.json(); if(d.parent) load(d.parent) })
load(START)
</script>
</body>
</html>`

/** Normalize an absolute path under ROOT, rejecting traversal. */
function underRoot(p) {
  const abs = resolve(p)
  if (ROOT === sep) return abs
  if (abs !== ROOT && !abs.startsWith(ROOT + sep)) return null
  return abs
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`)
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(INDEX_HTML)
      return
    }
    if (url.pathname === '/api' || url.pathname === '/api/') {
      const requested = url.searchParams.get('path') || '/'
      const abs = underRoot(requested.startsWith('/') ? requested : join(ROOT, requested))
      if (!abs) { res.writeHead(403).end('outside root'); return }
      let st; try { st = statSync(abs) } catch { res.writeHead(404).end('not found'); return }
      if (!st.isDirectory()) { res.writeHead(400).end('not a directory'); return }
      const children = readdirSync(abs, { withFileTypes: true })
        .map(e => {
          const p = join(abs, e.name)
          let dir = e.isDirectory()
          let size = ''
          if (e.isFile()) { try { size = fmt(statSync(p).size) } catch {} }
          else if (e.isSymbolicLink()) { try { dir = statSync(p).isDirectory() } catch { return null } }
          return { name: e.name, path: p, dir, size }
        })
        .filter(Boolean)
        .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'zh'))
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ path: abs, parent: abs === ROOT ? null : dirname(abs), children }))
      return
    }
    if (url.pathname === '/raw') {
      const p = underRoot(url.searchParams.get('path') || '')
      if (!p) { res.writeHead(403).end('outside root'); return }
      try {
        const st = statSync(p)
        if (!st.isFile()) { res.writeHead(400).end('not a file'); return }
        res.writeHead(200, { 'content-disposition': 'inline', 'x-content-type-options': 'nosniff' })
        res.end(readFileSync(p))
      } catch { res.writeHead(404).end('not found') }
      return
    }
    res.writeHead(404).end('not found')
  } catch (err) {
    res.writeHead(500).end(String(err))
  }
})

function fmt(n) {
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'
  return (n / 1073741824).toFixed(1) + ' GB'
}

server.listen(PORT, HOST, () => {
  console.log(`[files-server] ${HOST}:${PORT} root=${ROOT}`)
})
