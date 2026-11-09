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

    // local API key check (WORKER_API_KEY optional; if unset, reject protected routes)
    const protectedPaths = ['/v1/chat/completions', '/v1/models', '/v1/usage'];
    if (protectedPaths.includes(url.pathname)) {
      const key = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
      if (!env.WORKER_API_KEY || !env.FREEPI_TOKEN) {
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
          headers: { 'Authorization': 'Bearer ' + env.FREEPI_TOKEN },
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

    // usage passthrough from /me
    if (url.pathname === '/v1/usage') {
      let me;
      try {
        me = await fetch('https://api.freepi.ai/me', { headers: freepiHeaders(env.FREEPI_TOKEN) });
      } catch (err) {
        return Response.json({ error: { message: 'upstream unreachable', code: 'upstream_error' } }, { status: 502, headers: cors });
      }
      const data = await me.json().catch(() => ({}));
      return Response.json({
        remaining_credits_today: data.remaining_credits_today,
        remaining_usd_today: data.remaining_usd_today,
        cap_usd_today: data.cap_usd_today,
        refill_at: data.refill_at,
        tier: data.tier,
        handle: data.handle,
        raw_status: me.status,
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

      // token pool: primary + optional alt; 409/429 on primary → try alt once
      let upstream;
      const tokens = [env.FREEPI_TOKEN, env.FREEPI_TOKEN_ALT].filter(Boolean);
      try {
        await warmAds(env.FREEPI_TOKEN);
        upstream = await chatFetch(tokens[0], body);
        // session gate: release stuck slot and retry / switch token (upstream returns 409 or 429)
        if ((upstream.status === 409 || upstream.status === 429) && tokens.length > 1) {
          const probe = await upstream.text();
          if (probe.includes('concurrent_session')) {
            // reset primary in background, serve via alt
            fetch('https://api.freepi.ai/session/reset', {
              method: 'POST', headers: { 'Authorization': 'Bearer ' + tokens[0] },
            }).catch(() => {});
            upstream = await chatFetch(tokens[1], body);
            if (upstream.status === 409 || upstream.status === 429) {
              await upstream.text().catch(() => '');
              await fetch('https://api.freepi.ai/session/reset', {
                method: 'POST', headers: { 'Authorization': 'Bearer ' + tokens[1] },
              }).catch(() => {});
              upstream = await chatFetch(tokens[1], body);
            }
          } else {
            upstream = new Response(probe, { status: upstream.status, headers: upstream.headers });
          }
        } else if (upstream.status === 409 || upstream.status === 429) {
          const probe = await upstream.text();
          if (probe.includes('concurrent_session')) {
            await fetch('https://api.freepi.ai/session/reset', {
              method: 'POST', headers: { 'Authorization': 'Bearer ' + tokens[0] },
            }).catch(() => {});
            upstream = await chatFetch(tokens[0], body);
          } else {
            upstream = new Response(probe, { status: upstream.status, headers: upstream.headers });
          }
        }
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
  if (!token) throw new Error('FREEPI_TOKEN not set');
  return {
    'Authorization': 'Bearer ' + token,
    'x-session-id': sessionId(),
    'x-client-version': '0.6.15',
  };
}

function chatFetch(token, body) {
  return fetch('https://api.freepi.ai/v1/chat/completions', {
    method: 'POST',
    headers: { ...freepiHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// per-isolate session id, generated lazily inside handler scope (global-scope crypto.randomUUID is disallowed)
let SESSION_ID = null;
function sessionId() {
  if (!SESSION_ID) SESSION_ID = crypto.randomUUID();
  return SESSION_ID;
}

// ads gate: upstream pauses free completions when it thinks ads aren't showing.
// Simulate the CLI's banner flow: fetch an ad, report the impression. Failures ignored —
// upstream only needs a steady trickle of impressions, not a valid one per request.
let adsWarmed = false;
async function warmAds(token) {
  if (adsWarmed) return;
  adsWarmed = true;
  try {
    const sid = sessionId();
    const next = await fetch('https://api.freepi.ai/ads/next?slot=banner', {
      headers: { 'Authorization': 'Bearer ' + token, 'x-session-id': sid },
    });
    if (!next.ok) return;
    const ad = await next.json();
    await fetch('https://api.freepi.ai/ads/impression', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'x-session-id': sid, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ad_id: ad.ad_id, click_token: ad.click_token, imp_fired: true }),
    });
  } catch {}
}
