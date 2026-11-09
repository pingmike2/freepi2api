// OpenCode provider plugin for FreePI (freepi.ai) — the free daily credits
// your free-pi token carries. Works in OpenCode and in magpie, which runs
// OpenCode's provider plugins unchanged.
//
// The endpoint is OpenAI-compatible chat completions at api.freepi.ai/v1,
// but three upstream gates stand between a plain request and an answer,
// and this plugin handles each where the SDK can't:
//   - ads_required (403): the account must have served an ad impression
//     before its first chat. The plugin fires the impression pair once per
//     process, before the account's first request.
//   - concurrent_session (409/429): the account's four CLI session slots
//     are held (each stuck slot frees itself after 30 minutes, or now via
//     POST /session/reset). The plugin reads the refusal, resets the
//     account and asks once more.
//   - concurrent (429): one request at a time per account. With a second
//     token signed in (Methods › FreePI token, added twice) magpie's own
//     failover moves the request to the other account; inside one account
//     the plugin retries through its own waits.
//
// The token comes from the free-pi CLI's GitHub device sign-in. Paste it
// once (Methods › FreePI token); it is a JWT valid 90 days, and /me's
// refill_at shows when the daily credits come back.

const PROVIDER = "freepi"
const BASE = "https://api.freepi.ai/v1"
const ORIGIN = "https://api.freepi.ai"
const CLIENT_VERSION = "0.6.15"

// [id, name, context, output] — the catalog GET /client-version lists live;
// these are the ids it named on 2026-11-10, with the catalog's own usage
// multiplier in the name so the list says what a model costs. The live
// provider.models read replaces this list whenever /client-version answers.
const MODELS = [
  ["particle", "Particle · ~1x", 128000, 16384],
  ["deepseek-v4-flash", "DeepSeek V4 Flash · 1x", 128000, 16384],
  ["glm-5.3-flash", "GLM 5.3 Flash · ~1.5x", 128000, 16384],
  ["gpt-6-luna", "GPT-6 Luna · ~2x", 128000, 16384],
  ["gpt-6-luna-flex", "GPT-6 Luna Flex · ~2x · slower", 128000, 16384],
  ["mimo-v2.6-flash", "MiMo V2.6 Flash · ~2.8x", 128000, 16384],
  ["qwen3.5-35b-darkbloom", "Qwen3.5 35B Darkbloom · ~2.9x", 128000, 16384],
  ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash · ~3x", 128000, 16384],
  ["gpt-oss-120b-speed", "GPT-OSS 120B · ~3x", 128000, 16384],
  ["muse-spark-1.3-contributor", "Muse Spark 1.3 Contributor (trains on your data) · ~2x", 128000, 16384],
  ["solar-pro-4", "Solar Pro 4 · ~0.6x (cheapest)", 32000, 8192],
  ["laguna-s-2.1", "Laguna S 2.1 · free preview then ~1.8x", 128000, 16384],
  ["deepseek-v4-pro", "DeepSeek V4 Pro · ~18x", 128000, 16384],
  ["gpt-6.1-terra", "GPT-6.1 Terra · ~20x", 128000, 16384],
  ["gpt-6.1-terra-flex", "GPT-6.1 Terra Flex · ~20x · slower", 128000, 16384],
  ["gpt-6.1-sol-flex", "GPT-6.1 Sol Flex · ~41x", 128000, 16384],
  ["kimi-k3.1-pro", "Kimi K3.1 Pro · daily limit · ~41x", 128000, 16384],
]

const modelOf = ([id, name, context, output]) => ({
  id,
  name,
  limit: { context, output },
  tool_call: true,
})

// The waits between retries of a session gate, longest last: about nine
// seconds of them. Past that the gate goes back as it came.
const RESET_WAITS = [250, 600, 1200, 2400]

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// sessionGate says a refusal is the four-slots gate, whose fix is a reset
// (the one-request cap's own word, "concurrent" without "session", is a
// real queue and resets nothing).
function sessionGate(status, text) {
  if (status !== 409 && status !== 429) return false
  return text.includes("concurrent_session")
}

export const FreePIAuthPlugin = async () => {
  // one ad impression per process, per account: the account's first chat
  // answers 403 ads_required until it has served one
  const adsWarmed = new Set()

  async function warmAds(token) {
    if (adsWarmed.has(token)) return
    adsWarmed.add(token)
    try {
      const next = await fetch(`${ORIGIN}/ads/next?slot=banner`, {
        headers: { authorization: `Bearer ${token}` },
      })
      if (!next.ok) return
      const ad = await next.json()
      if (!ad?.ad_id || !ad?.click_token) return
      await fetch(`${ORIGIN}/ads/impression`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ ad_id: ad.ad_id, click_token: ad.click_token, imp_fired: true }),
      })
    } catch {
      // the warm-up is best-effort: the gate's 403 names itself, and the
      // request path answers it below when the impression didn't land
    }
  }

  // resetFrees resets the account's stuck session slots; best-effort, the
  // slot also frees itself after 30 minutes
  async function resetFrees(token) {
    try {
      await fetch(`${ORIGIN}/session/reset`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      })
    } catch {}
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "FreePI",
        npm: "@ai-sdk/openai-compatible",
        api: BASE,
        models: Object.fromEntries(MODELS.map((m) => [m[0], modelOf(m)])),
      }
    },

    auth: {
      provider: PROVIDER,
      icon: "https://freepi.ai/favicon.ico",
      maxConcurrency: 4,
      methods: [
        {
          type: "oauth",
          label: "Sign in with GitHub (device code)",
          async authorize(_inputs, { signal } = {}) {
            // the free-pi device flow: mint a session, show GitHub's own
            // device page (magpie opens the url and shows the code), poll
            // until the account answers, then read the handle so the
            // account's row names itself
            let device
            try {
              const res = await fetch(`${ORIGIN}/auth/github/device`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{}",
                signal,
              })
              if (!res.ok) throw new Error(`FreePI answered ${res.status}`)
              device = await res.json()
            } catch (e) {
              return { type: "failed", error: `FreePI device sign-in: ${e?.message ?? e}` }
            }
            const sid = device?.session_id
            const code = device?.user_code
            const url = device?.verification_uri_complete ?? device?.verification_uri
            if (!sid || !code || !url) {
              return { type: "failed", error: "FreePI device sign-in: no session came back" }
            }
            // consent first, so the poll below is answered on its merits
            try {
              await fetch(`${ORIGIN}/auth/consent`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  session_id: sid,
                  consent_version: "4",
                  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
                  locale: "en",
                }),
                signal,
              })
            } catch {}
            const interval = Math.max(Number(device.interval) || 5, 3) * 1000
            const deadline = Date.now() + (Number(device.expires_in) || 900) * 1000
            return {
              url,
              instructions: `Enter the code ${code} on GitHub, then Authorize.`,
              method: "auto",
              async callback(_code, { signal } = {}) {
                for (;;) {
                  if (Date.now() > deadline) {
                    return { type: "failed", error: "the sign-in expired; start again" }
                  }
                  await sleep(interval)
                  if (signal?.aborted) return { type: "failed", error: "cancelled" }
                  let res
                  try {
                    res = await fetch(`${ORIGIN}/auth/token`, {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({
                        session_id: sid,
                        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
                        locale: "en",
                      }),
                      signal,
                    })
                  } catch {
                    continue // a hiccup: ask again
                  }
                  if (!res.ok) {
                    const text = await res.text().catch(() => "")
                    if (res.status >= 400 && res.status < 500 && res.status !== 403 && res.status !== 429) {
                      return { type: "failed", error: `FreePI sign-in: ${text || res.status}` }
                    }
                    continue
                  }
                  const body = await res.json().catch(() => null)
                  if (body?.status === "pending") continue
                  if (!body?.token) {
                    return { type: "failed", error: "FreePI sign-in: unexpected answer" }
                  }
                  const token = body.token
                  let accountId
                  try {
                    const me = await fetch(`${ORIGIN}/me`, {
                      headers: { authorization: `Bearer ${token}` },
                      signal,
                    })
                    if (me.ok) accountId = (await me.json())?.handle
                  } catch {}
                  // a success with key is kept as an API key, so both
                  // sign-in methods land in the same loader
                  return { type: "success", key: token, accountId: accountId ?? "freepi account" }
                }
              },
            }
          },
        },
        {
          type: "api",
          label: "FreePI token (paste the free-pi CLI's JWT)",
          placeholder: "eyJhbG…",
        },
      ],

      // what every request of this account is sent with: the free-pi CLI's
      // own headers, the ads warm-up before the account's first chat, and
      // the session-gate reset-and-retry
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        const token = auth.key
        return {
          baseURL: BASE,
          apiKey: token,
          async fetch(input, init) {
            await warmAds(token)
            const request = new Request(input, init)
            if (request.method !== "POST") return fetch(request)
            let res = await fetch(request, {
              headers: (() => {
                const h = new Headers(request.headers)
                h.set("authorization", `Bearer ${token}`)
                h.set("x-session-id", crypto.randomUUID())
                h.set("x-client-version", CLIENT_VERSION)
                return h
              })(),
            })
            // the gates: an ads 403 warms again and asks once more; a
            // session gate resets and asks again through the waits
            for (let i = 0; i <= RESET_WAITS.length; i++) {
              if (res.status !== 403 && res.status !== 409 && res.status !== 429) break
              const text = await res.text()
              if (res.status === 403 && text.includes("ads_required")) {
                adsWarmed.delete(token)
                await warmAds(token)
                res = await fetch(request, {
                  headers: (() => {
                    const h = new Headers(request.headers)
                    h.set("authorization", `Bearer ${token}`)
                    h.set("x-session-id", crypto.randomUUID())
                    h.set("x-client-version", CLIENT_VERSION)
                    return h
                  })(),
                })
                continue
              }
              if (!sessionGate(res.status, text) || i === RESET_WAITS.length) {
                return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers })
              }
              await resetFrees(token)
              await sleep(RESET_WAITS[i] * (0.75 + Math.random() * 0.5))
              res = await fetch(request, {
                headers: (() => {
                  const h = new Headers(request.headers)
                  h.set("authorization", `Bearer ${token}`)
                  h.set("x-session-id", crypto.randomUUID())
                  h.set("x-client-version", CLIENT_VERSION)
                  return h
                })(),
              })
            }
            return res
          },
        }
      },

      // magpie's own hook: the account's daily credits, from /me. OpenCode
      // ignores it; magpie draws the quota card from it.
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return { error: "not signed in", windows: [] }
        try {
          const res = await fetch(`${ORIGIN}/me`, { headers: { authorization: `Bearer ${auth.key}` } })
          if (!res.ok) return { error: `FreePI answered ${res.status}`, windows: [] }
          const me = await res.json()
          const allowance = me.allowance_credits ?? 0
          const left = me.remaining_credits_today ?? 0
          const used = Math.max(0, allowance - left)
          const percent = allowance > 0 ? Math.round((used / allowance) * 100) : 0
          return {
            plan: `FreePI · ${left}/${allowance} credits`,
            windows: [
              {
                name: "Daily credits",
                used: percent,
                resetsAt: me.refill_at,
                span: 24 * 3600,
              },
            ],
          }
        } catch (e) {
          return { error: e?.message ?? String(e), windows: [] }
        }
      },
    },

    provider: {
      id: PROVIDER,
      // the live catalog: GET /client-version names every model the day
      // serves, with its usage multiplier in the name; a read that fails
      // keeps the static list above
      async models(provider, { auth } = {}) {
        if (auth?.type !== "api" || !auth.key) return provider.models
        try {
          const res = await fetch(`${ORIGIN}/client-version`, {
            headers: { authorization: `Bearer ${auth.key}` },
          })
          if (!res.ok) return provider.models
          const cv = await res.json()
          const list = (cv.models ?? []).filter((m) => m && m.id && !m.unavailable)
          if (!list.length) return provider.models
          const base = provider.models["deepseek-v4-flash"]
          return Object.fromEntries(
            list.map((m) => [
              m.id,
              {
                ...(base ?? {}),
                id: m.id,
                name: m.name ?? m.id,
                limit: (base?.limit) ?? { context: 128000, output: 16384 },
                tool_call: true,
              },
            ]),
          )
        } catch {
          return provider.models
        }
      },
    },

    "chat.headers": async (input, output) => {
      const id = input?.model?.providerID ?? input?.provider?.info?.id
      if (id !== PROVIDER) return
      // nothing to add: the session id is per-request on purpose (the gate
      // counts slots, and one fresh id a request holds no slot after the
      // answer ends)
    },
  }
}

export default { id: PROVIDER, server: FreePIAuthPlugin }
