# Security Policy · 安全政策

## Reporting a vulnerability / 报告漏洞

**Please do NOT open a public issue for security vulnerabilities.**
**请不要用公开 issue 报告安全漏洞。**

Instead, email **ilifelahepeq54@gmail.com** with:

- A description of the vulnerability and its impact
- Steps to reproduce (a minimal PoC is ideal)
- Affected version / commit

You should get an acknowledgement within **7 days**. Please allow a reasonable
window for a fix before any public disclosure. This is a solo-maintained
project — response times are best-effort, but security reports are read first.

请发邮件到 **ilifelahepeq54@gmail.com**,附上:漏洞描述与影响、复现步骤(最好有最小 PoC)、受影响的版本/commit。
一般 **7 天内**会收到确认回复。公开披露前请留出合理的修复窗口。本项目由个人维护,响应时间尽力而为,但安全报告永远优先处理。

## Scope notes / 范围说明

- Neo binds to `127.0.0.1` by default and authenticates the owner via a local
  token (`?t=` URL parameter). Reports about what an attacker can do **from the
  same machine** or **after the owner exposes `PANEL_HOST=0.0.0.0`** are still
  welcome, but please state the threat model clearly.
- The license system is a local Ed25519 check by design; "the gate can be
  patched out in a fork" is documented behavior, not a vulnerability.

- Neo 默认只监听 `127.0.0.1`,owner 身份靠本地 token(URL 里的 `?t=`)。同机攻击者能做什么、或 owner 主动暴露 `PANEL_HOST=0.0.0.0` 之后的问题也欢迎报告,但请写清威胁模型。
- license 是本地 Ed25519 校验,属设计如此;"fork 里可以把门改掉"是文档中写明的行为,不算漏洞。
