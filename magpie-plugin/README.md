# freepi — FreePI (freepi.ai) provider plugin for magpie / OpenCode

[magpie](https://usemagpie.ai) / OpenCode provider plugin that turns your
own FreePI account's free daily credits into a provider every agent can
use: no Worker, no deployment, your token straight to api.freepi.ai.

The companion project — a Cloudflare Worker that proxies the same API as
a plain OpenAI-compatible endpoint — lives at
[pingmike2/freepi2api](https://github.com/pingmike2/freepi2api).

## Install

**magpie (app)**: Plugins → Add a plugin → paste:

```sh
github:pingmike2/freepi-magpie-plugin
```

or from a terminal:

```sh
magpie plugin add github:pingmike2/freepi-magpie-plugin
magpie plugin login freepi   # choose the GitHub device sign-in
magpie provider test freepi  # ✓ chat · glm-5.3-flash
```

Installed this way, updates are one click: a push to `main` shows the
update dot on Plugins → Update all.

**OpenCode**: add the repository to `plugin` in `opencode.json`:

```json
{ "plugin": { "freepi": "github:pingmike2/freepi-magpie-plugin" } }
```

or a cloned folder: `{ "plugin": { "freepi": "/absolute/path/to/freepi-magpie-plugin" } }`

## Sign in

**magpie / the app**: pick **Sign in with GitHub (device code)** — the
plugin mints a device session, opens GitHub's own device page, shows the
code, and finishes on its own. Nothing to paste.

GitHub pre-fills the code on its device page. If the box comes up empty
(e.g. you had to sign in to GitHub first and landed back on the page),
just type the code shown in magpie, then press Continue and Authorize.

Accounts are named after the GitHub handle in both sign-in methods — the
device flow reads it from the API, and pasted tokens are validated
against `/me` on save, so a bad token is rejected right away.

**Multiple accounts, each with its own proxy**: that is a magpie app
feature, not plugin code — set a per-account SOCKS5/HTTP proxy in the
account's settings, and every request this plugin makes for that account
inherits it automatically (same design as the zcode plugin).

**A terminal (OpenCode)**: `magpie plugin login freepi` and choose the
same method; or paste a token you minted by hand:

```sh
curl -s -X POST https://api.freepi.ai/auth/github/device -d '{}' -H 'content-type: application/json'
# → open verification_uri_complete in a browser, sign in with GitHub
curl -s -X POST https://api.freepi.ai/auth/token \
  -d '{"session_id":"<from above>","timezone":"Asia/Shanghai","locale":"zh-CN"}' \
  -H 'content-type: application/json'
# → {"token":"eyJ…"}  — shown once, copy it now
```

The token is a JWT valid 90 days. Daily credits: 15,000 (established
accounts), +5,000 per qualified invite, refilled at UTC midnight.

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

MIT
