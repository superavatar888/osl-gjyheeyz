#!/usr/bin/env bash
# gate.sh - cron 兜底检查：守护正常则跳过本 run（防排队堆积），守护全挂才真正跑 sell
# 判断逻辑（查 GitHub API 本 repo 最近 run，排除自己）：
#   none             → 无 run 记录，放行（兜底该跑）
#   active           → 有其他 run 在跑/排队，守护正常，跳过
#   success:<10min   → 刚跑完，守护马上会接力，跳过（防双跑）
#   success:>=10min  → 跑完很久没人接力，守护挂了，放行兜底
#   failure/其他     → 上次失败且没人接力，放行兜底
set -e
# 手动触发（workflow_dispatch）直接放行；只有 cron 兜底才走 gate 检查
if [ "$GITHUB_EVENT_NAME" = "workflow_dispatch" ]; then
  echo "skip=false" >> "$GITHUB_OUTPUT"
  echo "gate_state=manual"
  exit 0
fi
RUNS=$(curl -sf -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$GITHUB_REPOSITORY/actions/runs?per_page=5") || \
  { echo "skip=false" >> "$GITHUB_OUTPUT"; echo "gate_state=api-error"; exit 0; }
STATE=$(echo "$RUNS" | GITHUB_RUN_ID="$GITHUB_RUN_ID" python3 - <<'PY'
import sys, json, datetime, os
try:
    d = json.load(sys.stdin)
except Exception:
    print('api-error'); sys.exit()   # API 数据异常 → 放行（保守：宁可多跑不遗漏）
rs = d.get('workflow_runs', []) if isinstance(d, dict) else []
self_id = os.environ.get('GITHUB_RUN_ID')
others = [r for r in rs if str(r.get('id')) != self_id]
if not others:
    print('none'); sys.exit()
r = others[0]
if r.get('status') in ('in_progress', 'pending', 'queued'):
    print('active'); sys.exit()
if r.get('status') == 'completed':
    try:
        end = datetime.datetime.fromisoformat(r['updated_at'].replace('Z', '+00:00'))
    except Exception:
        print('api-error'); sys.exit()
    mins = int((datetime.datetime.now(datetime.timezone.utc) - end).total_seconds() / 60)
    print(f"{r.get('conclusion')}:{mins}")
else:
    print('other')
PY
)
case "$STATE" in
  active) echo "skip=true" >> "$GITHUB_OUTPUT" ;;          # 有其他 run 在跑/排队 → 守护正常，跳过
  success:*)
    m="${STATE#success:}"
    if [ "$m" -lt 10 ]; then echo "skip=true" >> "$GITHUB_OUTPUT"; else echo "skip=false" >> "$GITHUB_OUTPUT"; fi
    ;;
  *) echo "skip=false" >> "$GITHUB_OUTPUT" ;;              # none/失败/api-error/其他 → 放行兜底
esac
echo "gate_state=$STATE"
