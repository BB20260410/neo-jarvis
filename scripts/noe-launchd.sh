#!/bin/zsh
# noe-launchd.sh — Noe panel launchd 守护一键管理（强健③，2026-06-10）
# 用法: ./scripts/noe-launchd.sh install|uninstall|status|restart
# 按项目约定本脚本由 owner 主动执行（Claude 不代跑 launchctl）。

set -euo pipefail
PLIST_SRC="$(cd "$(dirname "$0")/.." && pwd)/docs/launchd/com.noe.panel.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.noe.panel.plist"
LABEL="com.noe.panel"

case "${1:-status}" in
  install)
    [[ -f "$PLIST_SRC" ]] || { echo "❌ 找不到 $PLIST_SRC"; exit 1; }
    plutil -lint "$PLIST_SRC" >/dev/null || { echo "❌ plist 语法不合法"; exit 1; }
    # 端口占用提示：手动 npm start 和守护会撞端口
    if lsof -ti :51835 >/dev/null 2>&1; then
      echo "⚠️ 51835 已有进程在跑（手动启动的 panel?）。装守护前请先停掉它（Ctrl+C 或 kill），否则守护会反复拉起失败。"
      exit 1
    fi
    cp "$PLIST_SRC" "$PLIST_DST"
    launchctl load "$PLIST_DST"
    echo "✅ 已安装并启动。日志: /tmp/noe-panel.launchd.log"
    echo "   开机自启 + 崩溃 15 秒自动拉起。卸载: $0 uninstall"
    ;;
  uninstall)
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    rm -f "$PLIST_DST"
    echo "✅ 已卸载（panel 已停止、不再自启）。手动启动恢复用: npm start"
    ;;
  restart)
    launchctl kickstart -k "gui/$(id -u)/$LABEL" && echo "✅ 已强制重启（改完代码后用这个让新代码生效）"
    ;;
  status)
    if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
      echo "✅ 守护已安装"
      launchctl print "gui/$(id -u)/$LABEL" | grep -E "state|pid" | head -3
      curl -s -o /dev/null -w "panel HTTP %{http_code}\n" "http://127.0.0.1:51835/" || true
    else
      echo "⏸ 守护未安装。安装: $0 install"
    fi
    ;;
  *)
    echo "用法: $0 install|uninstall|status|restart"; exit 2 ;;
esac
