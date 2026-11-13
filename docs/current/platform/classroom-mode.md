---
status: current
layer: platform
domain: classroom-mode
canonical_for:
  - classroom-mode-home
  - classroom-mode-stage
  - classroom-mode-window-aspect
related:
  - docs/current/platform/index.md
  - docs/current/platform/architecture-and-code-placement.md
  - docs/current/platform/agent-runtime.md
  - docs/changes/2026-11-13-classroom-simulation/design.md
  - docs/source/课堂模拟图像素材规格.md
last_verified: 2026-11-13
---

# 课堂模式

本页描述 `apps/desktop` 与 classroom API 当前实际生效的课堂模式：侧栏入口先打开课堂首页（进行中课堂、历史总结、开始新课堂），进入课堂后是占用整窗的 16:9 舞台；一轮对话由老师消息和一名学生回应组成，消息写入本地 JSONL，结束课堂后按需生成模型总结。

## 入口与课堂首页

| 项 | 当前事实 |
|---|---|
| 入口 | 侧栏「知识掌握」下方的「课堂模式」（`SidebarView = 'classroom'`） |
| 首页布局 | 与「知识掌握」同构：保留侧栏，右上「开始新课堂」，主体分「进行中的课堂」与「历史课堂」 |
| 进行中 | 最近一条 `active` 课堂：开始时间 +「结束课堂」/「继续上课」 |
| 历史 | `ended` 按结束时间倒序：日期、总结状态、摘要预览（已去掉 Markdown 符号）；点击进入只读详情（完整总结 + 消息记录，可重新生成总结）；行尾垃圾桶确认后删除课堂行、总结与记录目录 |
| 空态 | 无进行中课堂时显示说明文案；「开始新课堂」进入草稿舞台，不发消息不创建课堂 |
| 数据 | `GET /api/lessons?status=active|ended`、`POST /api/lessons`（草稿首次发送时）、`POST /api/lessons/:id/end`、`GET /api/lessons/:id/summary`、`DELETE /api/lessons/:id` |
| 组件 | [ClassroomHome.tsx](../../../apps/desktop/src/features/classroom/ClassroomHome.tsx) 负责首页与详情；[classroom-api.ts](../../../apps/desktop/src/features/classroom/classroom-api.ts) 封装请求与运行时校验 |

只有进入舞台时窗口才锁 16:9；首页保持普通窗口与侧栏。

## 课堂舞台

- 进入方式：首页「继续上课」进入已有课堂，或「开始新课堂」进入草稿舞台。
- 草稿舞台第一次发送时才创建课堂（同时结束旧 active）；课堂存在且为 `active` 时才显示「结束课堂」，空草稿退出不会留下任何记录。
- 舞台独占窗口内容区，渲染同一张 16:9 背景图；顶部左侧是「退出课堂」与「结束课堂」分段控件。
- 「退出课堂」回到首页，课堂保持 `active`，草稿在本次应用会话内保留；再次进入重新拉取记录。
- 结束课堂弹确认框，确认后调用 `POST /api/lessons/:id/end` 返回首页，并在后台生成总结。
- 已结束的课堂进入时显示只读提示，输入区不可用。
- 组件：[ClassroomMode.tsx](../../../apps/desktop/src/features/classroom/ClassroomMode.tsx)。

### 一轮对话

| 状态 | 输入区 | 行为 |
|---|---|---|
| 首次讲解 | 四行文本框（固定 96px） | `Ctrl/Cmd + Enter` 或「发送」→ `POST /api/lessons/:id/turns` |
| 已有记录 | 单行回答框 + 内联「发送」 | 每次提交同样进入 `/turns`，返回全量消息 |
| 发送中 | 讲解立刻浮在输入框上方，输入框清空并切为单行回答框；三名学生头顶各显示「正在思考中…」 | 同课堂并发的第二轮由后端返回 409；失败时恢复未落盘的草稿 |
| 失败 | 保留草稿并显示稳定文案 | 先重新拉取记录再提示，避免重复发送 |

- 学生气泡只显示最新一条学生消息，按 `speaker` 定位：`lin` 左（22%）、`su` 中（50%）、`gu` 右（78%）；老师发送回答后气泡消失。
- 等待模型时三个座位各有一个小气泡「正在思考中…」（左侧带旋转加载图标），响应到达后一起替换为真实学生气泡。
- 同一知识点最多 2 次学生发言；第 3 次学生只确认理解并请老师继续下一个知识点，导演判定老师是否开启新知识点。
- 讲稿发送后浮在输入框上方约 3.6 秒，然后只存在于消息侧栏。
- 输入框不带附件、不带斜杠命令。

### 消息侧栏

- 默认折叠；右下角圆形按钮显示消息总数，展开为右侧覆盖抽屉。
- 每条记录显示说话人名（老师 / 苏小满 / 林澈 / 顾知夏）与正文，按时间正序，打开或新增时滚到最新。
- 记录损坏时顶部显示「记录有 N 行损坏，已跳过」，舞台仍可用已解析内容；追加会被后端拒绝。

## 结束课堂与总结

1. 确认结束 → `ended`，回到首页。
2. 首页在后台调用 `POST /api/lessons/:id/summary`，期间每 3 秒轮询列表；完成显示摘要预览，失败可「重新生成」。
3. 总结存于 SQLite `lessons`（`summaryStatus/summaryMarkdown/summaryError/summaryGeneratedAt`），由一次 `LlmService.generate()` 生成四节 Markdown；消息仍在 JSONL。
4. 只有 `ended` 课堂能生成总结；`active` 请求返回 409。

## 记录与恢复

| 场景 | 行为 |
|---|---|
| 正常一轮 | 老师消息先写入 `<configDir>/lessons/<lessonId>/messages.jsonl`，学生回复成功后追加 |
| 损坏记录 | 读接口 `200 + integrity.degraded`；追加被拒绝 |
| 恢复 | 首页或舞台「开始新课堂」结束当前 active 并新建 UUID 课堂；旧记录保留不修复 |
| 重启 | 首页与舞台都从 API 读取，无进程内消息状态 |

## 窗口 16:9

渲染层只声明「舞台是否在屏幕上」，几何由 main 决定：

| 层 | 事实 |
|---|---|
| `window.teachforge.setClassroomMode(enabled)` | 舞台挂载时开启、卸载时关闭；首页不调用 |
| 进入 | 先退出全屏/最大化，`planAspectLock` 由当前尺寸算出内容区 16:9 |
| 拖动 | `will-resize` 内按实测边框补偿，保留位移更大的轴，另一轴按比例推导 |
| 离开 | 删除锁；用户没在模式内改过尺寸时写回 baseline |

CSS 上 `.tf-classroom-viewport` 提供容器尺寸，`.tf-classroom-stage` 取视口内最大的 16:9 矩形并居中；窗口无法锁比例时舞台留边而不变形。`win.setAspectRatio` 因约束外框已在实测中否决，详见[课堂模式与 16:9 窗口设计](../../changes/2026-11-12-classroom-mode/design.md)。

## 与设计稿的差异

| 项 | 草案 | 当前实现 |
|---|---|---|
| 课堂流程 | 讲解→轮转提问→报告 | 讲解/回答与一名学生回应；报告与评估仍未实现 |
| 学生立绘 | 3 张独立立绘 + 前景条 | 单张 16:9 背景图内绘三名学生；气泡按 `speaker` 定位 |
| 消息持久化 | 结束时写入会话历史 | 独立 `lessons` + JSONL，不与 conversation 绑定 |
| 课堂总结 | 未定义 | P2 模型总结（四节，无评分/掌握度） |

## 验证方式

- `npm run test:classroom-lessons --workspace @teachforge/backend`：消息列表、创建/幂等结束、损坏降级、列表与预览、总结读写、发言端点的状态校验。
- `npm run test:classroom-turns --workspace @teachforge/backend`：每课堂运行锁。
- `npm run test:classroom-summaries --workspace @teachforge/backend`：总结生成、失败、损坏、并发、启动重置。
- `npm run build:renderer --workspace @teachforge/desktop`：首页与舞台类型检查与打包。
- 实机（Win11，Chrome 1568×880 + 桌面桥 mock）：首页显示进行中课堂与历史总结；进入舞台发送讲解后气泡落在 `su` 头顶、侧栏计数与单行回答框正确。
