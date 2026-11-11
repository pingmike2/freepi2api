/**
 * freepi2api — freepi.ai → OpenAI-compatible API proxy (Cloudflare Worker)
 *
 * Upstream contract (reverse-engineered from free-pi-cli 0.6.15, verified 2026-11-09):
 * - POST https://api.freepi.ai/v1/chat/completions  (OpenAI chat format, SSE supported)
 * - Headers: Authorization: Bearer <JWT>, x-session-id: <uuid>, x-client-version: <ver>
 * - Only model: deepseek/deepseek-v4-flash (any model param lands here server-side)
 * - Concurrency 1 per account; daily 15000 credits (~$1.125), resets 00:00 UTC
 * - GET /me → remaining_credits_today / refill_at
 * - JWT valid 90 days
 * - Ads gate: server tracks ad impressions per account; without them chat returns
 *   403 {code:"ads_required"}. Fix: GET /ads/next?slot=banner then POST /ads/impression
 *   {ad_id, click_token, imp_fired:true} — done lazily before each chat.
 * - Session gate: max 4 concurrent CLI sessions per account; 429 {code:"concurrent_session"}.
 *   Fix: POST /session/reset (Bearer only) releases the stuck slot.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const VERSION = '1.0.0';

    // healthz: public, before auth; no token/key info leaked
    if (url.pathname === '/healthz') {
      return Response.json({ status: 'ok', version: VERSION }, { headers: cors });
    }

    // freepi passthrough: any /freepi/<path> goes to api.freepi.ai/<path>
    // verbatim from the worker's own egress — clients behind ad-gate-blocked
    // IPs (e.g. WARP) route their whole client through here. Authenticated
    // with the same WORKER_API_KEY; the caller's own FreePI Bearer rides along.
    if (url.pathname.startsWith('/freepi/')) {
      const key = (request.headers.get('x-worker-key') || (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim());
      const a = new TextEncoder().encode(key), b = new TextEncoder().encode(env.WORKER_API_KEY);
      let diff = a.length ^ b.length;
      for (let i = 0; i < Math.min(a.length, b.length); i++) diff |= a[i] ^ b[i];
      if (diff !== 0 || !env.WORKER_API_KEY) {
        return Response.json({ error: { message: 'Invalid API key', code: 'invalid_api_key' } }, { status: 401, headers: cors });
      }
      const upstream = new URL('https://api.freepi.ai' + url.pathname.replace(/^\/freepi/, '') + url.search);
      const fwd = new Request(upstream, request);
      fwd.headers.delete('x-worker-key');
      fwd.headers.delete('host');
      fwd.headers.delete('cf-connecting-ip');
      fwd.headers.delete('cf-ipcountry');
      fwd.headers.delete('cf-ray');
      fwd.headers.delete('cf-visitor');
      fwd.headers.delete('x-forwarded-for');
      fwd.headers.delete('x-forwarded-proto');
      fwd.headers.delete('x-real-ip');
      return fetch(fwd);
    }

    // local API key check (WORKER_API_KEY optional; if unset, reject protected routes)
    const protectedPaths = ['/v1/chat/completions', '/v1/models', '/v1/usage'];
    if (protectedPaths.includes(url.pathname)) {
      const key = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
      if (!env.WORKER_API_KEY || !poolOf(env).length) {
        return Response.json({ error: { message: 'service misconfigured', code: 'config_error' } }, { status: 500, headers: cors });
      }
      // constant-time compare
      const a = new TextEncoder().encode(key), b = new TextEncoder().encode(env.WORKER_API_KEY);
      let diff = a.length ^ b.length;
      for (let i = 0; i < Math.min(a.length, b.length); i++) diff |= a[i] ^ b[i];
      if (diff !== 0) {
        return Response.json({ error: { message: 'Invalid API key', code: 'invalid_api_key' } }, { status: 401, headers: cors });
      }
    }

    // models: fetch live catalog from /client-version (falls back to static list)
    if (url.pathname === '/v1/models') {
      let list = null;
      try {
        const cv = await fetch('https://api.freepi.ai/client-version', {
          headers: { 'Authorization': 'Bearer ' + poolOf(env)[0] },
        });
        if (cv.ok) {
          const d = await cv.json();
          if (Array.isArray(d.models)) {
            list = d.models
              .filter((m) => !m.unavailable)
              .map((m) => ({ id: m.id, object: 'model', owned_by: m.section === 'defense' ? 'freepi-defense' : 'freepi' }));
          }
        }
      } catch {}
      if (!list) list = [{ id: 'deepseek-v4-flash', object: 'model', owned_by: 'freepi' }];
      return Response.json({ object: 'list', data: list }, { headers: cors });
    }

    // usage passthrough from /me; every account in the pool reports its own
    // row, so one hitting its hourly ceiling stays visible
    if (url.pathname === '/v1/usage') {
      const tokens = poolOf(env);
      const rows = await Promise.all(tokens.map(async (token) => {
        try {
          const me = await fetch('https://api.freepi.ai/me', { headers: freepiHeaders(token) });
          const data = await me.json().catch(() => ({}));
          return {
            handle: data.handle,
            remaining_credits_today: data.remaining_credits_today,
            remaining_usd_today: data.remaining_usd_today,
            cap_usd_today: data.cap_usd_today,
            refill_at: data.refill_at,
            tier: data.tier,
            raw_status: me.status,
          };
        } catch {
          return { error: 'upstream unreachable' };
        }
      }));
      if (!rows.length) {
        return Response.json({ error: { message: 'no token configured', code: 'upstream_error' } }, { status: 502, headers: cors });
      }
      // primary keeps the top-level shape; every account rides in accounts[]
      const [primary, ...rest] = rows;
      return Response.json({
        ...primary,
        accounts: rows,
        primary: rows[0],
        pool_size: rows.length,
        ...(rest.length ? { alt: rest[0] } : {}),
      }, { headers: cors });
    }

    // chat completions → upstream
    if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: { message: 'invalid JSON body', code: 'bad_request' } }, { status: 400, headers: cors });
      }
      // forward requested model id (catalog: particle, deepseek-v4.1-flash, glm-5.3-flash,
      // gpt-6-luna, deepseek-v4-pro, gpt-oss-120b-speed, solar-pro-4, defense models, ...).
      // Unknown ids land on deepseek-v4-flash server-side. Keep requested id for response display.
      const requestedModel = body.model || 'deepseek-v4-flash';

      // token pool: walk the accounts in order — each one serves an ad
      // impression before its chat, answers the session gate in place, and
      // an account-level gate (ads paused, hourly ceiling, credits gone)
      // hands the request to the next account instead of ending it
      let upstream;
      const tokens = poolOf(env);
      try {
        upstream = await chatAcrossPool(tokens, body);
      } catch (err) {
        return Response.json({ error: { message: 'upstream unreachable', code: 'upstream_error' } }, { status: 502, headers: cors });
      }

      // stream: pipe SSE through verbatim
      if (body.stream) {
        return new Response(upstream.body, {
          status: upstream.status,
          headers: { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        });
      }

      const text = await upstream.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 2000) }; }
      // keep caller's requested model name in the response for client display
      if (data && data.model && data.model !== 'deepseek-v4-flash') {
        // upstream already echoes the real served model id (e.g. deepseek-v4-pro); leave it
      } else if (data && data.model) {
        data.model = requestedModel;
      }
      return new Response(JSON.stringify(data), {
        status: upstream.status,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    return Response.json({ error: { message: 'not found', code: 'not_found' } }, { status: 404, headers: cors });
  },
};

function freepiHeaders(token) {
  if (!token) throw new Error('no free-pi token in the pool');
  return {
    'Authorization': 'Bearer ' + token,
    // one session per worker lifetime, like one CLI session; the ads gate
    // tracks impressions per session, so ads and chat must share this id
    'x-session-id': sessionId(),
    'x-client-version': '0.6.19',
    // 0.6.19: one uuid per turn on the provider request; without it the
    // upstream answers with a fake "out of date" completion instead of 426
    'x-turn-id': turnId(),
  };
}

// what the 0.6.18 CLI sends on its ads requests: os / arch / locale /
// timezone fingerprint headers (only /ads/next carries them upstream)
function fingerprintHeaders(extra) {
  let tz = 'UTC', locale = 'en-US';
  try {
    const o = Intl.DateTimeFormat().resolvedOptions();
    if (o.timeZone) tz = o.timeZone;
    if (o.locale) locale = o.locale;
  } catch {}
  return { ...extra, 'x-client-os': 'linux', 'x-client-arch': 'x64', 'x-client-locale': locale, 'x-client-timezone': tz, 'x-session-id': sessionId(), 'x-turn-id': turnId() };
}

// The account pool. FREEPI_TOKENS is the list form — one secret holding
// every account, newline/comma/space separated, or a JSON array — so
// growing the pool never means touching this file again. FREEPI_TOKEN and
// FREEPI_TOKEN_ALT stay supported as the two-account shape.
function poolOf(env) {
  const out = [];
  const add = (value) => {
    if (!value) return;
    const text = String(value).trim();
    if (!text) return;
    let parts;
    if (text.startsWith('[')) {
      try {
        parts = JSON.parse(text);
        if (!Array.isArray(parts)) parts = [text];
      } catch {
        parts = text.split(/[\s,]+/);
      }
    } else {
      parts = text.split(/[\s,]+/);
    }
    for (const part of parts) {
      const token = String(part).trim().replace(/^["']|["']$/g, '');
      if (token && !out.includes(token)) out.push(token);
    }
  };
  add(env.FREEPI_TOKENS);
  add(env.FREEPI_TOKEN);
  add(env.FREEPI_TOKEN_ALT);
  return out;
}

function chatFetch(token, body) {
  return fetch('https://api.freepi.ai/v1/chat/completions', {
    method: 'POST',
    headers: { ...freepiHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// per-isolate session id, generated lazily inside handler scope (global-scope crypto.randomUUID is disallowed).
// Workers are single-threaded per isolate, so the lazily-minted id is safe
// to share across concurrent callers; the ads gate keys on it.
let SESSION_ID = null;
function sessionId() {
  if (!SESSION_ID) SESSION_ID = crypto.randomUUID();
  return SESSION_ID;
}
// one uuid per turn. sendWithGates mints a fresh one at the start of every
// attempt so the ads requests and that attempt's chat request share it;
// other callers (e.g. /v1/usage) just get a per-call uuid.
function turnId() {
  return TURN_ID || crypto.randomUUID();
}
let TURN_ID = null;

// ads gate: upstream pauses an account whose ad impressions went stale
// ("ads aren't showing for this account"). Serving one impression pair
// unpauses it at once, and the account then stays unpaused for a while
// (verified 2026-11-10: pause -> one warm -> 200, and the next chats kept
// answering without another warm). The CLI shows an ad before every
// foreground chat, so this worker does the same: one impression pair per
// request per account — that is what keeps the gate from ever tripping.
async function warmAds(token) {
  try {
    const next = await fetch('https://api.freepi.ai/ads/next?slot=banner', {
      headers: fingerprintHeaders({ 'Authorization': 'Bearer ' + token }),
    });
    if (!next.ok) return;
    const ad = await next.json();
    if (!ad || !ad.ad_id) return;
    // the CLI fires the gravity impression pixel before POSTing; the 0.6.19
    // gate checks that the session actually loaded the ad
    if (ad.imp_url && ad.imp_url.includes('trygravity.')) {
      await fetch(ad.imp_url, { method: 'GET' }).catch(() => {});
    }
    await fetch('https://api.freepi.ai/ads/impression', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'x-session-id': sessionId() },
      body: JSON.stringify({ ad_id: ad.ad_id, click_token: ad.click_token, imp_fired: true }),
    });
  } catch {}
}

// one account's chat with every gate answered in place: an ad impression
// before the request, the ads gate re-warming and asking once more, and
// the session gate resetting and asking once more
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendWithGates(token, body) {
  TURN_ID = crypto.randomUUID();
  await warmAds(token);
  // the upstream records impressions asynchronously: a chat fired the same
  // instant still reads the session as ad-less, so give the record a beat
  await sleep(400);
  let res = await chatFetch(token, body);
  if (res.status === 403) {
    const probe = await res.text();
    if (probe.includes('ads_required')) {
      TURN_ID = crypto.randomUUID();
      await warmAds(token);
      await sleep(400);
      res = await chatFetch(token, body);
    } else {
      res = new Response(probe, { status: res.status, headers: res.headers });
    }
  }
  // 0.6.19+: a tripped ads gate can answer 200 with a fake "out of
  // date" completion (prompt_tokens 0). JSON-only check — never read a
  // streaming body. Rewarm, wait, ask once more.
  if (res.status === 200 && !(res.headers.get('content-type') || '').includes('text/event-stream')) {
    const probe = await res.clone().text();
    if (probe.includes('"prompt_tokens":0') && probe.includes('shows ads')) {
      TURN_ID = crypto.randomUUID();
      await warmAds(token);
      await sleep(800);
      res = await chatFetch(token, body);
    }
  }
  if (res.status === 409 || res.status === 429) {
    const probe = await res.text();
    if (probe.includes('concurrent_session')) {
      await fetch('https://api.freepi.ai/session/reset', {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + token },
      }).catch(() => {});
      TURN_ID = crypto.randomUUID();
      await warmAds(token);
      await sleep(400);
      res = await chatFetch(token, body);
    } else {
      res = new Response(probe, { status: res.status, headers: res.headers });
    }
  }
  return res;
}

// the account-level gates that only another account can answer
const ACCOUNT_GATES = ['ads_required', 'hourly_ceiling', 'credits_exhausted', 'daily_ceiling', 'quota_exhausted'];
function isAccountGate(text) {
  return ACCOUNT_GATES.some((gate) => text.includes(gate));
}

// walk the pool in order: each account gets a warm + chat + in-place gate
// handling, and an account-level gate passes the request to the next one
// instead of ending the request
async function chatAcrossPool(tokens, body) {
  let last = null;
  for (const token of tokens) {
    let res;
    try {
      res = await sendWithGates(token, body);
    } catch {
      continue; // this account is unreachable; the pool may still answer
    }
    if (res.status !== 403 && res.status !== 429) return res;
    const text = await res.text().catch(() => '');
    if (!isAccountGate(text)) {
      return new Response(text, { status: res.status, headers: res.headers });
    }
    last = new Response(text, { status: res.status, headers: res.headers });
  }
  return last ?? Response.json({ error: { message: 'no token configured', code: 'upstream_error' } }, { status: 502, headers: { ...cors } });
}
