# TeachForge

TeachForge 桌面端和本地服务的起始脚手架。当前包含一个本地 Agent 工作台：Electron 启动 NestJS 服务，React 页面通过受控 Preload 访问健康检查、Agent 对话和 Conversation API。

## 环境

- Node.js 22.13 或更高版本（推荐 22 或 24 LTS）
- npm 10 或更高版本

## 开发

```bash
npm install
npm run dev
```

`npm run dev` 会先构建 NestJS，再启动 Vite、Electron 主进程和本地后端。桌面开发模式使用系统 Node 启动后端，避免 SQLite 原生模块与 Electron ABI 不匹配。

独立调试后端：

```bash
npm run dev:backend
```

独立后端监听 `127.0.0.1:4318`，开发令牌为 `teachforge-local-dev-token`。业务接口需要在 `x-teachforge-token` 请求头中传入该令牌。

## 构建

```bash
npm run build
```

构建后在当前开发机启动桌面应用：

```bash
npm run start:desktop
```

后端数据库默认位于 `apps/backend/.data/teachforge.db`；桌面模式使用 Electron 的应用数据目录。设置 `TEACHFORGE_DATA_DIR` 可覆盖桌面模式的数据目录。数据库结构通过 TypeORM Migration 管理，生产配置关闭 `synchronize`。

## API

- `GET /api/health`
- `POST /api/agent/stream`
- `GET /api/conversations`
- `GET /api/conversations/:id/messages`

所有请求均需携带 `x-teachforge-token`，并且服务只监听 Loopback。
