#!/bin/sh
# 停掉临时启动的 Noe 面板（释放 51835 端口与内存）。
PID=$(lsof -nP -iTCP:51835 -sTCP:LISTEN -t 2>/dev/null)
if [ -n "$PID" ]; then
  kill $PID && echo "面板已停止 (pid $PID)。"
else
  echo "面板当前未在运行。"
fi
