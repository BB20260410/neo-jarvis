# 交接文档：Noe 新软件分支

日期：2026-06-01  
新软件目录：`/Users/hxx/Desktop/可视化面板_新软件分支_2026-06-01`  
来源项目：`/Users/hxx/Desktop/00_项目/05_Claude可视化面板`  
新产品临时名：`Noe`

## 一句话总结

这个目录是从原 Xike Lab / Claude 可视化面板完整复制出来的新软件分支，已经完成基础产品身份隔离：不会默认抢原项目的端口、owner token、数据目录、launchd label 和 Electron appId。

## 已做隔离

- 产品名：`Noe`
- npm 包名：`noe`
- Electron appId：`com.hxx.noe`
- 默认端口：`51835`
- 默认数据目录：`~/.noe-panel`
- owner token：`~/.noe-panel/owner-token.txt`
- restart 日志：`/tmp/noe-panel-51835.log`
- launchd label：`com.hxx.noe.panel51835`
- Electron 输出目录：`out-noe`

## 为什么这样做

原项目继续保留在：

```text
/Users/hxx/Desktop/00_项目/05_Claude可视化面板
```

新软件在独立目录开发：

```text
/Users/hxx/Desktop/可视化面板_新软件分支_2026-06-01
```

两边默认不会共用：

- 端口
- owner token
- 本地数据
- launchd 服务名
- Electron app 身份
- 打包输出目录

这样可以基于原项目继续开发另一个软件，同时避免破坏原项目稳定版。

## 本轮没有做的事

- 没有提交 git。
- 没有 push。
- 没有启动新软件服务。
- 没有跑测试。
- 没有删除复制过来的旧 `out/` 构建产物；新软件后续打包会输出到 `out-noe/`。

## 下一步建议

1. 先进入新软件目录：

```bash
cd /Users/hxx/Desktop/可视化面板_新软件分支_2026-06-01
```

2. 启动前确认依赖可用：

```bash
npm run check:panel
```

如果原项目还在运行，没关系：新软件默认端口是 `51835`。

3. 启动新软件：

```bash
PORT=51835 npm start
```

或：

```bash
PORT=51835 npm run restart:panel
```

4. 打开新软件：

```text
http://127.0.0.1:51835
```

如果提示需要 owner token，用：

```bash
cat ~/.noe-panel/owner-token.txt
```

或使用启动输出里的 `?t=...` 链接。

## 后续开发建议

优先把新软件从“复制版”变成真正的新产品：

1. 明确新软件定位、名称、核心用户和功能边界。
2. 清理 Xike Lab 遗留文案、价格页、GitHub 发布配置、商业化配置。
3. 重新设计首页、图标、品牌色和 Electron 菜单。
4. 独立配置签名、公证、DMG。
5. 建立自己的交接文档和测试基线。

## 给下个聊天框的复制提示

```text
你接手的是从 Xike Lab / Claude 可视化面板复制出来的新软件分支。

新软件目录：/Users/hxx/Desktop/可视化面板_新软件分支_2026-06-01
原项目目录：/Users/hxx/Desktop/00_项目/05_Claude可视化面板
交接文档：HANDOFF_2026-06-01_Noe_新软件分支.md

请只在新软件目录工作，不要改原项目。

本分支已经完成基础隔离：
- 产品名：Noe
- npm 包名：noe
- Electron appId：com.hxx.noe
- 默认端口：51835
- 数据目录：~/.noe-panel
- owner token：~/.noe-panel/owner-token.txt
- launchd label：com.hxx.noe.panel51835
- Electron 输出目录：out-noe

本轮没有 git commit、没有 push、没有启动服务、没有跑测试。

下一步请先只读确认：
cd /Users/hxx/Desktop/可视化面板_新软件分支_2026-06-01
npm run check:panel

如果要启动，使用：
PORT=51835 npm start

打开地址：
http://127.0.0.1:51835

重要边界：原项目是稳定版，不要改；新软件所有品牌、端口、数据、打包身份都应继续保持独立。
```
