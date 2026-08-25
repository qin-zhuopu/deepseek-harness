#!/bin/bash
# =====================================================================
# dsh-aio 端到端验证 + 全程日志记录
#
# 用法（在 WSL Ubuntu-24.04 内执行）:
#   NR_API_KEY=<你的真实key> bash verify-e2e.sh
#
# 或从 Windows PowerShell:
#   wsl -d Ubuntu-24.04 -- bash -c "NR_API_KEY=<key> bash /mnt/c/Users/14409.JEREH/dsh-aio/verify-e2e.sh"
#
# 它会:
#   1) 用 -e NR_API_KEY 注入重启 dsh-aio 容器
#   2) 创建 dsh 会话, 让 agent 用 mcp__chrome__ 工具打开百度
#   3) 全程抓取三路日志到 ./logs/ :
#        - container-supervisor.log  (容器 supervisor + chrome-devtools-mcp + CDP)
#        - session-events.jsonl      (dsh 会话事件流: tool/call, tool/result, turn/end)
#        - cdp-pages.json            (Chrome 当前打开的页面, 来自 CDP)
#   4) 从日志判定跑通: turn/end reason=completed 且 出现 mcp__chrome__ 工具调用
#      且 Chrome 打开了百度 (标题「百度一下，你就知道」)
# =====================================================================
set -u

LOGDIR="$(dirname "$0")/logs"
mkdir -p "$LOGDIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
DSH=http://127.0.0.1:3080
CDP=http://127.0.0.1:9222

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOGDIR/run-$STAMP.log"; }

if [ -z "${NR_API_KEY:-}" ]; then
  log "ERROR: NR_API_KEY 未设置。用法: NR_API_KEY=<key> bash verify-e2e.sh"
  exit 2
fi

# ---- 1) 注入 key 重启容器 ----
log "STEP 1: 重启 dsh-aio, 通过 -e 注入 NR_API_KEY (len=${#NR_API_KEY})"
docker rm -f dsh-aio >/dev/null 2>&1
docker run -d --name dsh-aio --network host --shm-size=1g \
  -e NR_API_KEY="$NR_API_KEY" dsh-aio:dev >/dev/null 2>&1
log "容器已启动, 等待全栈就绪..."

# 等 dsh 端口
for i in $(seq 1 60); do
  curl -sf "$DSH/" >/dev/null 2>&1 && break; sleep 1
done
curl -sf "$DSH/" >/dev/null 2>&1 && log "dsh 就绪 (3080)" || { log "ERROR: dsh 未就绪"; exit 1; }
curl -sf "$CDP/json/version" >/dev/null 2>&1 && log "CDP 就绪 (9222)" || log "WARN: CDP 未就绪"

# 确认注入的 key 被容器看到
KLEN=$(docker exec dsh-aio bash -lc 'echo -n ${#NR_API_KEY}')
log "容器内 NR_API_KEY 长度: $KLEN"

# ---- 2) 创建会话并发 prompt ----
log "STEP 2: 创建会话, 发送打开百度的 prompt"
SID=$(python3 - <<'PY'
import json,urllib.request,uuid
def call(m,p):
  b={"type":"client-request","rpcId":str(uuid.uuid4()),"method":m,"payload":p}
  r=urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:3080/api/"+m,
    data=json.dumps(b).encode(),
    headers={"content-type":"application/json","Origin":"http://127.0.0.1:3080"},
    method="POST"),timeout=30)
  return json.loads(r.read().decode())
c=call("session.create",{"cwd":"/app"})
sid=c["result"]["value"]["sessionId"]
prompt=("请使用你的 chrome 浏览器工具（mcp__chrome__ 开头的工具）打开百度首页 "
        "https://www.baidu.com ，然后用 list_pages 确认页面已打开，并告诉我页面标题。")
call("session.prompt",{"sessionId":sid,"mode":"queue",
     "content":[{"type":"text","text":prompt}]})
print(sid)
PY
)
log "会话: $SID"

# ---- 3) 抓容器 supervisor + mcp 日志 (后台持续) ----
log "STEP 3: 持续抓取三路日志"
docker logs -f dsh-aio > "$LOGDIR/container-supervisor.log" 2>&1 &
LOGPID=$!

# 轮询会话事件, 落盘并判定
RESULT="TIMEOUT"
for i in $(seq 1 60); do
  python3 - "$SID" > "$LOGDIR/session-events.jsonl" <<'PY'
import json,urllib.request,uuid,sys
sid=sys.argv[1]
b={"type":"client-request","rpcId":str(uuid.uuid4()),"method":"session.history","payload":{"sessionId":sid}}
r=urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:3080/api/session.history",
  data=json.dumps(b).encode(),
  headers={"content-type":"application/json","Origin":"http://127.0.0.1:3080"},
  method="POST"),timeout=30)
ev=json.loads(r.read().decode())["result"]["value"].get("events",[])
for e in ev: print(json.dumps(e,ensure_ascii=False))
PY
  # 判定: 必须出现真实的 tool/call 事件(name 以 mcp__chrome__ 开头), 且 turn 已结束。
  # 用 python 精确解析事件, 避免误匹配事件流里的"工具定义清单"(schema)。
  VERDICT=$(python3 - "$LOGDIR/session-events.jsonl" <<'PY'
import json,sys
real_toolcall=False; turn_kind=None
for line in open(sys.argv[1],encoding="utf-8"):
    try: e=json.loads(line)
    except: continue
    ev=e.get("event",e); t=ev.get("type",""); d=ev.get("data",{})
    if t=="tool/call" and str(d.get("name","")).startswith("mcp__chrome__"):
        real_toolcall=True
    if t=="turn/end":
        turn_kind=(d.get("reason") or {}).get("kind")
print(("call" if real_toolcall else "nocall")+":"+str(turn_kind))
PY
)
  case "$VERDICT" in
    call:completed) RESULT="DONE"; break ;;
    *:error|*:cancelled) RESULT="TURN_$VERDICT"; break ;;
  esac
  sleep 3
done

# CDP 当前页面落盘
curl -s "$CDP/json" > "$LOGDIR/cdp-pages.json" 2>&1

kill $LOGPID 2>/dev/null

# ---- 4) 从日志判定 ----
log "STEP 4: 从日志判定"
echo "----------------------------------------" | tee -a "$LOGDIR/run-$STAMP.log"

SUMMARY=$(python3 - "$LOGDIR/session-events.jsonl" <<'PY'
import json,sys
calls=[]; results=0; turn_kind=None; asst=[]
for line in open(sys.argv[1],encoding="utf-8"):
    try: e=json.loads(line)
    except: continue
    ev=e.get("event",e); t=ev.get("type",""); d=ev.get("data",{})
    if t=="tool/call":
        n=d.get("name","")
        if str(n).startswith("mcp__chrome__"): calls.append(n)
    if t=="tool/result": results+=1
    if t=="turn/end": turn_kind=(d.get("reason") or {}).get("kind")
    if t=="assistant/message":
        msg=d.get("message",d)
        for pt in (msg.get("content",[]) if isinstance(msg,dict) else []):
            if pt.get("type")=="text": asst.append(pt["text"])
print("TOOLS::"+(" ".join(calls) if calls else "（无真实调用）"))
print("TURN::"+str(turn_kind))
print("ASST::"+((asst[-1][:400]) if asst else "（无）"))
PY
)
log "会话中真实调用的 chrome MCP 工具: $(echo "$SUMMARY" | sed -n 's/^TOOLS:://p')"
log "turn/end 结果: $(echo "$SUMMARY" | sed -n 's/^TURN:://p')"
log "agent 最终回复: $(echo "$SUMMARY" | sed -n 's/^ASST:://p')"

BAIDU=$(python3 -c "import json,sys; d=json.load(open('$LOGDIR/cdp-pages.json')); print(' | '.join(p.get('title','')+' -> '+p.get('url','') for p in d if p.get('type')=='page'))" 2>/dev/null)
log "Chrome 当前页面 (CDP): $BAIDU"

MCPLOG=$(grep -c "chrome-devtools-mcp\|PerformanceIssue" "$LOGDIR/container-supervisor.log" 2>/dev/null)
log "容器日志中 chrome-devtools-mcp/CDP 通信行数: $MCPLOG"

echo "========================================" | tee -a "$LOGDIR/run-$STAMP.log"
if [ "$RESULT" = "DONE" ] && echo "$BAIDU" | grep -q "百度"; then
  log "判定: ✅ 跑通 —— agent 通过 MCP 工具打开了百度, 日志证据齐全"
  log "日志文件: $LOGDIR/{run-$STAMP.log, session-events.jsonl, container-supervisor.log, cdp-pages.json}"
  exit 0
else
  log "判定: ❌ 未跑通 (RESULT=$RESULT) —— 检查上述日志"
  log "常见原因: NR_API_KEY 无效 (上游 401) / 会话超时 / MCP 未连上"
  exit 1
fi
