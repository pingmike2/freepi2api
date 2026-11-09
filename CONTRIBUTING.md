# Contributing to freepi2api

## 硬约束（违反直接拒 PR）

1. **零 npm 依赖**：`worker.js` 必须单文件、只依赖 Workers 运行时内置 API（fetch / TextEncoder / crypto / Response）。不引入打包器、不引入依赖。
2. **密钥永不入库**：`FREEPI_TOKEN`、`WORKER_API_KEY` 只走 `wrangler secret put`。任何 diff 出现 `Bearer eyJ`、真实 key 赋值、`.dev.vars` 内容即拒绝。`wrangler.toml` 保持无 secrets。
3. **协议改动必须有实测依据**：改上游路径/头/字段前，先 curl 实测上游行为并在 PR 描述贴原始响应（可打码 token），不接受凭印象改协议。

## 测试环境

- 本地验证：`node --check worker.js` + `npx wrangler dev`（需要 `.dev.vars`，本地放，不入库）。
- 上游验证：对真实 freepi.ai 发一次最小请求（1 条消息，`max_tokens` 限制住），确认 200 + 非空 content。
- 不需要真实 token 也能跑的部分（healthz、鉴权拒绝路径）用 mock env 验证。

## 提交规范

- 一 PR 一件事：`feat:` / `fix:` / `docs:` 前缀。
- 行为改动必须同步 README（配置表、注意事项、坑列表）。
- 不改版本号（发版由维护者统一 bump）。

## 文案规矩

- README 中文为主，代码注释英文。
- 新增「坑」条目写进 README 的注意事项/快速参考对应小节，标题即答案。
