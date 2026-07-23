#!/bin/sh
# 临时启动并打开 Noe 面板：没在跑就后台起一个，然后浏览器打开（自动带 owner-token）。
# 用完用同目录的「停止面板.command」关掉，或关机自然结束。不常驻、不开机自启。
DIR="/Users/hxx/Desktop/00_项目/05_Claude可视化面板"
NODE="/Users/hxx/.nvm/versions/node/v22.22.2/bin/node"
URL="http://127.0.0.1:51835"

if ! curl -s "$URL/api/version" >/dev/null 2>&1; then
  echo "面板未运行，正在后台启动…"
  cd "$DIR" || exit 1
  CLAUDE_BIN="/Users/hxx/.npm-global/bin/claude" \
  PANEL_NO_OPEN=1 \
  PATH="/Users/hxx/.nvm/versions/node/v22.22.2/bin:/Users/hxx/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin" \
    nohup "$NODE" server.js > "$HOME/Backups/claude/panel.out.log" 2>&1 &
  for i in $(seq 1 40); do curl -s "$URL/api/version" >/dev/null 2>&1 && break; sleep 0.5; done
fi

if curl -s "$URL/api/version" >/dev/null 2>&1; then
  T=$(cat "$HOME/.noe-panel/owner-token.txt" 2>/dev/null)
  open "$URL/?t=$T"
  echo "已打开面板。用完可运行「停止面板.command」关闭。"
else
  echo "面板启动失败，看日志：$HOME/Backups/claude/panel.out.log"
  exit 1
fi
