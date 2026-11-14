#!/usr/bin/env bash
# 巡检单批量填报 + 模拟门户 一键演示（macOS / Linux，仅依赖 python3 标准库）
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PORT=8765
BASE="http://127.0.0.1:$PORT"
RUNTIME="$ROOT/runtime"
PORTAL_DIR="$RUNTIME/portal_data"
RUN_DIR="$RUNTIME/run_main"
RESUME_RUN="$RUNTIME/run_resume"
DOWN_RUN="$RUNTIME/run_down"
LOG="$RUNTIME/portal.log"
PID_FILE="$RUNTIME/portal.pid"

PY="$(command -v python3)"
banner() { printf '\n========== %s ==========\n' "$1"; }
wait_portal() {
  for _ in $(seq 1 50); do
    if curl -s -o /dev/null "$BASE/query"; then return 0; fi
    sleep 0.2
  done
  echo "门户未启动，查看 $LOG"; exit 1
}
configure_faults() {
  curl -s -X POST "$BASE/admin/faults" -H 'Content-Type: application/json' -d "$1" >/dev/null
  echo "故障注入配置：$1"
}

rm -rf "$RUNTIME"
mkdir -p "$PORTAL_DIR"

banner "1/8 启动模拟门户（SQLite 持久化，单号唯一）"
"$PY" -I "$ROOT/portal_server.py" --port "$PORT" --data-dir "$PORTAL_DIR" \
    --seed "$HERE/seed_conflict.csv" --fault-delay 6 >"$LOG" 2>&1 &
echo $! >"$PID_FILE"
trap 'kill "$(cat "$PID_FILE")" 2>/dev/null || true' EXIT
wait_portal
cat "$LOG"

banner "2/8 配置故障：XJ-2026-003 写入前超时；XJ-2026-004 写入后回执丢失（均一次性）"
configure_faults '{"pre_write_timeout":["XJ-2026-003"],"post_write_receipt_lost":["XJ-2026-004"],"fault_delay":6}'

banner "3/8 首轮批量填报（超时单将停在“仍待确认”，退出码 3 属预期）"
set +e
"$PY" -I "$ROOT/batch_submit.py" --csv "$HERE/inspection_orders.csv" \
    --base-url "$BASE" --state-dir "$RUN_DIR" --timeout 4
RC=$?
set -e
echo "首轮退出码：${RC}（3=存在仍待确认单据）"

banner "4/8 门户后台确认：两种故障均已落库/未落库且故障自动解除"
curl -s "$BASE/admin/faults"; echo

banner "5/8 重跑同一批：先按单号查门户 → 一致补回执 / 查不到才重提"
"$PY" -I "$ROOT/batch_submit.py" --csv "$HERE/inspection_orders.csv" \
    --base-url "$BASE" --state-dir "$RUN_DIR" --timeout 4

banner "6/8 中途退出演示：填报进程在停顿期被 kill，再重跑续完"
"$PY" -I "$ROOT/batch_submit.py" --csv "$HERE/orders_resume.csv" \
    --base-url "$BASE" --state-dir "$RESUME_RUN" --timeout 4 --row-delay 1 &
BATCH_PID=$!
sleep 1.5
kill -TERM "$BATCH_PID" 2>/dev/null || true
wait "$BATCH_PID" 2>/dev/null || true
echo "--- 填报进程已被 kill，当前状态 ---"
cat "$RESUME_RUN/result.csv" || true
echo "--- 重跑续跑（已终态行跳过，待确认行走查询恢复）---"
"$PY" -I "$ROOT/batch_submit.py" --csv "$HERE/orders_resume.csv" \
    --base-url "$BASE" --state-dir "$RESUME_RUN" --timeout 4

banner "7/8 门户宕机演示：停掉门户后填报 → 全部仍待确认；重启门户后重跑恢复"
kill "$(cat "$PID_FILE")"; wait "$(cat "$PID_FILE")" 2>/dev/null || true
set +e
"$PY" -I "$ROOT/batch_submit.py" --csv "$HERE/orders_resume.csv" \
    --base-url "$BASE" --state-dir "$DOWN_RUN" --timeout 4
DOWN_RC=$?
set -e
echo "门户不可达时退出码：${DOWN_RC}（3=仍待确认，属预期）"
"$PY" -I "$ROOT/portal_server.py" --port "$PORT" --data-dir "$PORTAL_DIR" \
    --fault-delay 6 >>"$LOG" 2>&1 &
echo $! >"$PID_FILE"
wait_portal
"$PY" -I "$ROOT/batch_submit.py" --csv "$HERE/orders_resume.csv" \
    --base-url "$BASE" --state-dir "$DOWN_RUN" --timeout 4

banner "8/8 最终结果"
echo "--- 主批次 result.csv ---"
cat "$RUN_DIR/result.csv"
echo
echo "--- 门户全部登记记录（/admin 页面可在浏览器查看）---"
curl -s "$BASE/admin" | sed -n '/已登记记录/,/当前故障注入/p' | sed 's/<[^>]*>/ /g' | tr -s ' '
echo
echo "演示完成。门户仍在运行：$BASE （PID $(cat "$PID_FILE")），再次执行本脚本会清空 runtime 重来。"
