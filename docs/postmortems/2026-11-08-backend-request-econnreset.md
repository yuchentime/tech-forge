---
status: accepted
layer: postmortem
domain: desktop-runtime
created_at: 2026-11-08
last_verified: 2026-11-08
canonical_for:
  - backend-request-econnreset-incident
related:
  - docs/postmortems/index.md
  - docs/current/platform/architecture-and-code-placement.md
  - apps/desktop/electron/main/backend-request.ts
  - apps/desktop/test/backend-request.test.cjs
---

# 2026-11-08 桌面桥接请求 ECONNRESET

## Summary

导入 DOCX 后提问期间，桌面主进程转发一个 `backend:request` 时抛 `TypeError: fetch failed ... ECONNRESET`。后端进程没有退出、DOCX 入库已完成（`ready`，222 分片）。结论：这是一次**连接层面的瞬时失败**，不是业务拒绝，也不是后端崩溃。

修复不依赖无法证实的根因：代理层改为每次请求关闭连接（不复用 keep-alive socket），对 socket 级失败重试一次，失败时返回中文可执行文案，并把方法/路径/错误码写入桌面日志。

## Impact

- 控制台出现一条错误；该请求在渲染层表现为一次失败（例如资料列表一次刷新失败、提示"暂时刷新失败，正在继续重试"）。
- 没有数据丢失：同一时刻的 DOCX 入库在一个事务内完成并进入 `ready`。

## Trigger

用户在 `npm run dev` 运行的桌面应用中导入 `学生手册-2026 - 脱敏版.docx`（837 KB）后提问，期间出现上述错误。

## Facts

| 关键证据 | 可以推出 | 不能推出 |
|---|---|---|
| `document_versions` 行为 `ready`、222 分片、222 条向量，`processingError` 为空 | 该 DOCX 的解析、分块与向量写入都成功完成 | 错误发生在哪一次具体请求 |
| 后端进程 pid 28136 启动于 23:52:53，故障后仍存活 | 后端没有崩溃或重启 | 后端内部各请求都成功 |
| `apps/backend/dist/main.js` mtime 23:52:50，早于后端启动 | 不是"运行中替换 dist 导致重启" | 之后没有其它构建写入 |
| 错误来自 `backend:request`（JSON 代理），不是 `/api/chat/stream` | 失败发生在普通请求路径 | 同一时刻 SSE 路径没有问题 |
| 用本地 HTTP 服务在一次请求中 `socket.destroy()` 可稳定复现 `fetch failed` + `ECONNRESET`，重试第二次成功 | 该错误形态与"连接被对端重置"一致，且一次重试足够 | 线上那一次重置的具体触发点 |

证据入口：[数据库快照查询](../../apps/backend/src/documents/documents.service.ts)（`document_versions`）、[新的单元测试](../../apps/desktop/test/backend-request.test.cjs)、[代理实现](../../apps/desktop/electron/main/backend-request.ts)。

## Root Cause

**未确认。** 缺失的证据是旧代理没有记录请求方法、路径和 socket 错误码，也没有保留连接复用状态。

最可能的机制：Node/Fastify 的 keep-alive 空闲连接在超过 `keepAliveTimeout`（Fastify 默认 72 s）后被服务端关闭，客户端连接池仍认为它可用，于是在下一次写入时收到 RST。DOCX 入库是主线程上的长 CPU 任务（解析 + 分块 + 向量），期间事件循环被占满，更容易让连接的空闲/关闭与下一次写入错位。

不采纳的替代解释：

- "后端崩了"：进程存活、端口未变、后续请求可用。
- "构建替换 dist 导致"：`dist` 写入完成早于后端进程启动。
- "业务错误被伪装成网络错误"：失败信息是 `fetch failed`，不是任何 HTTP 状态。

## Fix

| 变更 | 原因 |
|---|---|
| 代理请求固定发送 `connection: close` | 不保留可被对端关闭的空闲 socket，从源头消除复用竞态；回环地址上每次握手成本可忽略 |
| socket 级错误（`ECONNRESET`/`EPIPE`/`ECONNREFUSED`/`ETIMEDOUT`/`UND_ERR_*`）重试一次，间隔 150 ms | 该时刻响应未到达，重试不会重复业务副作用 |
| 重试仍失败时返回中文文案"本地服务连接中断，请重试；如果一直失败，请重启 TeachForge。（<code>）" | 用户看到可执行动作，技术码留给支持排查 |
| 记录 `method`/`path`/`code` 到桌面日志 | 下一次出现同类错误可直接定位请求与错误类型 |
| 未就绪、请求格式非法也改为中文 | 原英文提示对用户无意义 |

重试的安全前提是接口幂等：导入按内容哈希去重、设置是整体替换、删除第二次会返回 404。新增 `apps/desktop/test/backend-request.test.cjs`（5 项）覆盖：重置后重试成功、持续重置时的中文错误、非网络错误不重试、请求头与请求体契约、错误码提取。

## Insight

| 可复用洞察 | 本案依据 | 下次如何执行 |
|---|---|---|
| 传输失败 ≠ 业务失败 | 后端存活、入库成功，只有一条连接被重置 | 先确认对端进程与端口是否存活，再判断是网络还是业务状态 |
| 证据要按进程边界收集 | HTTP 在 Electron 主进程发起，渲染层只看到结果 | 代理层记录方法、路径与错误码，避免下次只能凭现象推断 |
| 无法证实的根因也要能修症状 | keep-alive 竞态无法回溯确认 | 选择不依赖根因的确定性措施（禁用复用），再保留一次重试兜底 |
| 重试必须有幂等前提 | 三个写接口都可重复执行 | 加任何自动重试前，先写清哪些接口可重复、重复的后果 |
| 长 CPU 任务会放大连接问题 | 入库是主线程长任务 | 稳定后再评估把解析/向量移出主线程，而不是先扩大超时 |

## 待确认

- 若再次出现，用新日志中的 `method`/`path`/`code` 判断是否仍是 socket 重置；若重试后依旧失败，应检查后端是否在长任务期间退出或被系统终止。
