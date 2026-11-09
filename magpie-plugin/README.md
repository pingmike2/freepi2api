# freepi2api magpie plugin — FreePI (freepi.ai) provider

[magpie](https://usemagpie.ai) / OpenCode provider plugin that turns your
own FreePI account's free daily credits into a provider every agent can
use — the same upstream this repo's Cloudflare Worker proxies, but running
as a plugin: no Worker, no deployment, your token straight to
api.freepi.ai.

## Install

**magpie (app)**: Plugins → Add a plugin → give it this folder
(`magpie-plugin/`), or from a terminal:

```sh
magpie plugin add ./magpie-plugin
magpie plugin login freepi   # paste your token
magpie provider test freepi  # ✓ chat · glm-5.3-flash
```

**OpenCode**: add the folder to `plugin` in `opencode.json`:

```json
{ "plugin": { "freepi": "/absolute/path/to/magpie-plugin" } }
```

## Get a token

The token is the free-pi CLI's own sign-in (a JWT, valid 90 days):

```sh
npx free-pi-cli@latest auth login
# GitHub device sign-in; the token lands in the CLI's config
```

or mint one by hand:

```sh
curl -s -X POST https://api.freepi.ai/auth/github/device -d '{}' -H 'content-type: application/json'
# → open verification_uri_complete in a browser, sign in with GitHub
curl -s -X POST https://api.freepi.ai/auth/token \
  -d '{"session_id":"<from above>","timezone":"Asia/Shanghai","locale":"zh-CN"}' \
  -H 'content-type: application/json'
# → {"token":"eyJ…"}  — shown once, copy it now
```

Paste it at `magpie plugin login freepi`. Daily credits: 15,000
(established accounts), +5,000 per qualified invite, refilled at UTC
midnight.

## What the plugin handles

| Upstream gate | What it is | The plugin's answer |
|---|---|---|
| `ads_required` 403 | the account must serve an ad impression before its first chat | fires `GET /ads/next` → `POST /ads/impression` once per process, again on the gate |
| `concurrent_session` 409/429 | the account's four CLI session slots are held (30-minute auto-release) | `POST /session/reset` + retry through waits |
| `concurrent` 429 | one request at a time per account | sign a second token as another account; magpie's failover moves the request |

## Models

The list comes live from `GET /client-version` (26 served ids on
2026-11-10), each named with its usage multiplier — `solar-pro-4 · ~0.6x`
is the cheapest, `glm-5.3-flash · ~1.5x` the everyday one. A read that
fails falls back to the built-in static list.

## Quota card (magpie)

`magpie quota` draws the account's real credit pool from `/me`:
remaining / allowance and the UTC refill time.

## License

MIT — same as the rest of this repo.
