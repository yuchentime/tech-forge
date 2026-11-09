---
status: current
layer: change
domain: agent-runtime
created_at: 2026-11-10
---

# 学生画像本地持久化 Brief

## Problem

学生画像只有 `rehearsals.personaText` 一份，跟着单次演练走。用户每次开始演练都要重新填写同一段画像，切到别的会话后也没有可继承的值。

## Decision / Scope

画像是一个本地个人偏好，不是每次演练的状态，因此不建表：

1. 存 `<configDir>/rehearsal-persona.txt`（默认 `~/.tech-forge/rehearsal-persona.txt`），纯文本，空文件等于"没有画像"。
2. `GET /api/rehearsal-persona` 读取；`PUT /api/rehearsal-persona` trim 后经同目录临时文件 + rename 原子替换（`0600`）。
3. 桌面端进入任一会话的演练模式时读取该文件并预填编辑器；编辑器失焦且内容变化时写回。
4. 开始演练仍把当时的文本作为 `persona` 传给 start 接口，历史演练各自保留 `personaText`，不受后续修改影响。

## Out Of Scope

- 多套画像、画像模板、按会话覆盖。
- 画像历史版本、跨设备同步。
- 把画像并入 settings 页面或 `config.toml`。

## 验收概要

- 新建/切换会话后进入演练模式，编辑器直接显示上次保存的画像。
- 编辑后失焦即写盘；不编辑而失焦不产生写入。
- 清空后失焦，文件为空，演练使用默认好奇学生画像。
- 超过 1000 字符被拒绝，文件保持原值。
- 保存失败时编辑器保留用户输入并显示错误，不静默丢弃。

## 验证

见 [verification.md](verification.md)。
