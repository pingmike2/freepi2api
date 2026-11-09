# freepi2api — freepi.ai → OpenAI 兼容 API 反代 (Cloudflare Worker)

把 freepi.ai 的免费 coding 模型额度包成标准 OpenAI API。部署在你自己的 Cloudflare Worker 上，上游协议已逆向验证（free-pi-cli 0.6.15）。

## 一键安装

```bash
git clone https://github.com/pingmike2/freepi2api.git
cd freepi2api
npm install -g wrangler   # 或用 npx 免装
```

## 架构

```
客户端 (OpenAI SDK)
   │  POST /v1/chat/completions
   │  Authorization: Bearer <WORKER_API_KEY>
   ▼
freepi2api (Cloudflare Worker)
   │  鉴权 → 换 FREEPI_TOKEN → 透传
   ▼
api.freepi.ai/v1/chat/completions
   │  Bearer <JWT> + x-session-id + x-client-version
   ▼
上游模型 (deepseek/deepseek-v4-flash, 多家 provider 轮换)
```

## 配置

| Secret | 说明 | 获取方式 |
|--------|------|----------|
| `FREEPI_TOKEN` | freepi.ai 的 JWT，90 天有效 | 见下方「获取 token」 |
| `FREEPI_TOKEN_ALT` | 可选，第二个账号的 JWT（两号写法，等价于 `FREEPI_TOKENS` 的第二项） | 同上，用另一个账号走一遍 |
| `FREEPI_TOKENS` | 可选，**多号写法**：一个 secret 装下全部账号，换行/逗号/空格分隔，或 JSON 数组 `["jwt1","jwt2"]`。扩号只改这一个 secret，不用动代码 | 同上，每个号走一遍 |
| `WORKER_API_KEY` | 客户端访问本 Worker 的密钥 | 自定义任意字符串 |

`wrangler.toml` 不含任何密钥，可直接入库。

### 获取 token

需要 GitHub 账号（freepi.ai 只支持 GitHub 登录，每日 15000 credits）：

```bash
# 1. 起一个 device flow 会话
curl -s -X POST https://api.freepi.ai/auth/github/device -H "content-type: application/json" -d '{}'
# 返回 session_id 和 user_code

# 2. 浏览器打开（用上一步的 user_code）
https://github.com/login/device?user_code=XXXXXXXX
# 登录 GitHub → 点 Authorize

# 3. 轮询拿 token（替换 <session_id>）
curl -s -X POST https://api.freepi.ai/auth/token \
  -H "content-type: application/json" \
  -d '{"session_id":"<session_id>","timezone":"Asia/Shanghai","locale":"zh-CN"}'
# 轮询到返回 {"token":"eyJ..."} 为止；token 一次性发放，拿到就存好
```

### 部署

```bash
npx wrangler secret put FREEPI_TOKEN      # 粘贴 JWT
npx wrangler secret put WORKER_API_KEY    # 粘贴自定义密钥
npx wrangler deploy
```

默认走 `*.workers.dev` 域名；若被网络拦截（error 1042），绑定自定义域：

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/domains" \
  -H "Authorization: Bearer <API_TOKEN>" -H "Content-Type: application/json" \
  -d '{"zone_id":"<ZONE_ID>","hostname":"freepi.你的域名","service":"freepi2api","environment":"production"}'
```

## 快速参考（运维）

```bash
# 剩余额度
curl -s https://<你的worker>/v1/usage -H "Authorization: Bearer <WORKER_API_KEY>"

# 健康检查（公开，无需 key）
curl -s https://<你的worker>/healthz

# 实时日志
npx wrangler tail
```

### 「error 1042」怎么办

`*.workers.dev` 在部分地区/ISP 被拦截（TLS 正常但响应 1042）。解决：按上面命令绑自定义域，绑后 1-2 分钟生效。

### 「concurrent」429 / 「concurrent_session」409 怎么办

上游限制同账号同时只能 1 个请求（`code: concurrent`，HTTP 429），账号最多 4 个 CLI 会话坑（`code: concurrent_session`，HTTP **409 或 429**，占满 30 分钟才自动释放）。Worker 对 `concurrent_session` 会自动调 `/session/reset` 释放并重试一次（实测占坑期间请求全部自愈）。

**号池按顺序走**：每个号先打一次广告曝光再发请求，撞到账号级门（`ads_required` 广告停摆 / `hourly_ceiling` 小时上限 / `credits_exhausted` 额度耗尽）就换下一个号，全池走完才把错误抛给客户端。配多个号的唯一目的就是扛 `hourly_ceiling`——它按小时计，广告怎么刷都解不开，只能靠另一个号顶。`/v1/usage` 会列出池里每个号的现状（`accounts[]`、`pool_size`）。

**扩号**：把新 JWT 追加进 `FREEPI_TOKENS`（换行分隔即可），重新 `wrangler secret put`，无需改代码、无需改配置。

### 「ads_required」403 怎么办

上游按账号统计广告曝光，没曝光就暂停免费额度。Worker 已内置：每次 chat 前自动拉一条 banner 广告并上报曝光（每个 isolate 一次）。若仍触发，用官方 CLI 跑一次让真实广告曝光即可恢复。

## 注意事项

- **模型目录有 26 个**（`/v1/models` 动态返回，来自上游 `/client-version`）：主力 `particle`(~1x) / `deepseek-v4-flash`(1x) / `glm-5.3-flash`(~1.5x) / `gpt-6-luna`(~2x) / `deepseek-v4.1-flash`(~3x) / `gpt-oss-120b-speed`(~3x) / `mimo-v2.6-flash`(~2.8x) / `solar-pro-4`(~0.6x) / `deepseek-v4-pro`(~18x) / `gpt-6.1-sol-flex`(~41x) / `kimi-k3.1-pro`(日限~41x) 等；`section:"defense"` 的是 abliterated/uncensored 系列（~20-60x）。`claude-sonnet-5.5`/`gpt-6.1-sol`/`gemini-4-argon` 标记 unavailable 会被过滤。
- **usage 倍率**：模型名后的 ~Nx 是额度消耗倍率——deepseek-v4-flash 1x 最省，ultrafast 295x 一下就烧光日额度，选模型注意。
- **未知 model 名**会落回 deepseek-v4-flash 服务端；响应里的 `model` 字段是上游实际服务 model 的真实回显（不再伪装成请求名）。
- **实测可用**（生产过 worker）：glm-5.3-flash / deepseek-v4-pro / gpt-6-luna / solar-pro-4 / deepseek-v4.1-flash / gpt-oss-120b-speed / particle 均正常返回。
- **ads_required 门**：上游按账号统计广告曝光量，长期没有曝光会 403 暂停免费额度。Worker 每次 chat 前自动模拟 CLI 的 banner 曝光上报；如仍触发，跑一次官方 CLI 即可。
- **并发 = 1**：上游按账号强制单并发，第二条并发请求返回 429 `{code: concurrent}`。账号最多 4 个 CLI 会话坑，占满返回 `concurrent_session`（HTTP 409 或 429，Worker 自动 reset 重试一次）。
- **日额度**：15000 credits ≈ $1.125/天（按 token 折算扣），UTC 零点重置；`/v1/usage` 可查。
- **JWT 90 天有效**：过期后重新走「获取 token」流程；token 是一次性发放，丢失只能重新授权。
- **不要把 FREEPI_TOKEN 提交到任何仓库**——它绑定你的 GitHub 账号，泄露等于把账号额度送人。
- 上游协议来自对 free-pi-cli 的逆向，上游改动（如 consent 版本、路径）可能使本Worker失效。

## 致谢 (Acknowledgements)

| 项目 | 在本项目里干什么活 |
|------|--------------------|
| [free-pi-cli](https://github.com/dennisonbertram/free-pi-cli) | 上游 CLI 本体，MIT 开源，协议逆向依据 |
| [free-pi](https://freepi.ai) | 提供免费推理额度 |
| [Cloudflare Workers](https://workers.cloudflare.com) | 运行时 |

## 免责声明 (Disclaimer)

- 本项目仅供学习、研究与个人技术实验使用。使用前请自行阅读并遵守 free-pi.ai 的服务条款（Terms of Service / Privacy Policy）；将 CLI 会话包装成 API 可能违反其 ToS，后果自负。
- 本项目与 free-pi、Cloudflare 及其上游模型供应商均无关联、无背书（not affiliated with or endorsed by any of them）。
- 上游可用性取决于对方策略：下架、加闸、限流、改协议随时可能发生，本项目不担保服务的持续性或稳定性。需要稳定通道请直接使用 free-pi 官方 CLI 或付费方案。
- 本项目不收集、不存储任何用户数据；所有请求经 Worker 即时转发，无持久化日志。
- 使用产生的一切风险由使用者自担；软件按「现状」提供，详见 [LICENSE](./LICENSE)。

## License

[MIT](./LICENSE) © 2026 [pingmike2](https://github.com/pingmike2)
