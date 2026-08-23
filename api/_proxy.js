/**
 * Shared upstream proxy for the Vercel serverless functions.
 *
 * In local dev, `vite.config.js`'s `server.proxy` handles /api/* and injects auth headers.
 * That proxy does NOT exist in a Vercel deployment (the build is static files on a CDN),
 * so these functions reproduce it. Keep the two in sync: same paths, same headers, same
 * upstreams.
 *
 * ROUTING NOTE — do not "simplify" this back to a catch-all file.
 * `api/github/[...path].js` looked correct but Vercel matched it as a SINGLE dynamic
 * segment literally named `...path`: `/api/github/rate_limit` worked while
 * `/api/github/repos/facebook/react` returned Vercel's own NOT_FOUND before ever reaching
 * the function. Instead `vercel.json` rewrites `/api/<name>/:path*` to a plain
 * `/api/<name>` function with the full remainder handed over as `?upstreamPath=...`,
 * which is unambiguous and doesn't depend on catch-all filename semantics.
 *
 * Secrets are read from process.env at request time and never reach the browser.
 */

const UPSTREAM_PARAM = 'upstreamPath';

/** Rebuild the upstream path + query from the rewritten request. */
function buildUpstreamPath(req, prefix) {
  const query = req.query || {};

  let rest = query[UPSTREAM_PARAM];
  if (Array.isArray(rest)) rest = rest.join('/');

  // Preserve the caller's own query params (e.g. ?recursive=1), minus our routing param.
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (k === UPSTREAM_PARAM) continue;
    if (Array.isArray(v)) v.forEach((item) => params.append(k, item));
    else if (v != null) params.append(k, String(v));
  }
  const search = params.toString();

  if (typeof rest === 'string' && rest.length) {
    const path = rest.startsWith('/') ? rest : '/' + rest;
    return path + (search ? `?${search}` : '');
  }

  // Fallback for a direct hit that skipped the rewrite: slice the prefix off req.url.
  const rawUrl = req.url || '/';
  const sliced = rawUrl.startsWith(prefix) ? rawUrl.slice(prefix.length) : rawUrl;
  return sliced.startsWith('/') ? sliced : '/' + sliced;
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {{ prefix: string, target: string, headers: Record<string, string|undefined> }} opts
 */
export async function proxyRequest(req, res, opts) {
  const { prefix, target, headers } = opts;
  let upstreamUrl = target;

  try {
    upstreamUrl = target + buildUpstreamPath(req, prefix);

    const outHeaders = { Accept: 'application/json', 'User-Agent': 'repo-world' };
    for (const [k, v] of Object.entries(headers)) {
      if (v) outHeaders[k] = v;
    }

    const method = req.method || 'GET';
    let body;
    if (method !== 'GET' && method !== 'HEAD' && req.body != null) {
      body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      outHeaders['Content-Type'] = 'application/json';
    }

    const upstream = await fetch(upstreamUrl, { method, headers: outHeaders, body });
    const text = await upstream.text();

    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    // Public upstream path only — no secrets. Makes a misrouted proxy debuggable straight
    // from the browser's network tab instead of by guesswork.
    res.setHeader('X-Proxy-Upstream', upstreamUrl.slice(0, 200));
    res.send(text);
  } catch (err) {
    res.status(502);
    res.setHeader('Content-Type', 'application/json');
    res.send(
      JSON.stringify({
        error: 'upstream_failed',
        upstream: upstreamUrl.slice(0, 200),
        detail: String(err?.message || err),
      })
    );
  }
}
