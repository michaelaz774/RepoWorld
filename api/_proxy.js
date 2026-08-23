/**
 * Shared upstream proxy for Vercel serverless functions.
 *
 * In local dev, `vite.config.js`'s `server.proxy` handles /api/* and injects the auth
 * headers. That proxy does NOT exist in a Vercel deployment (the build is static files on
 * a CDN), so these functions reproduce it. Keep the two in sync: same paths, same injected
 * headers, same upstreams.
 *
 * Secrets are read from process.env at request time and never reach the browser.
 */

/**
 * Rebuild the upstream path + query from the incoming request.
 *
 * Vercel is not consistent about what `req.url` contains for a catch-all route (it may or
 * may not still carry the /api/<name> prefix depending on rewrites), and getting this wrong
 * silently produces URLs like https://api.github.com/api/github/repos/... which 404 — the
 * exact failure this function exists to avoid. So prefer the parsed catch-all segments
 * (`req.query.path`), which are unambiguous, and only fall back to string-slicing req.url.
 */
function buildUpstreamPath(req, prefix) {
  const query = req.query || {};
  const segments = query.path;

  // Preserve every query param except the catch-all itself.
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (k === 'path') continue;
    if (Array.isArray(v)) v.forEach((item) => params.append(k, item));
    else if (v != null) params.append(k, String(v));
  }
  const search = params.toString();

  if (Array.isArray(segments) && segments.length) {
    return '/' + segments.map(encodeURIComponent).join('/') + (search ? `?${search}` : '');
  }
  if (typeof segments === 'string' && segments) {
    return '/' + encodeURIComponent(segments) + (search ? `?${search}` : '');
  }

  // Fallback: slice the prefix off req.url if it's still present.
  const rawUrl = req.url || '/';
  const path = rawUrl.startsWith(prefix) ? rawUrl.slice(prefix.length) : rawUrl;
  return path.startsWith('/') ? path : '/' + path;
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
    // Surfaced so a misrouted proxy is debuggable from the browser's network tab without
    // guessing. Contains no secrets — only the public upstream path being requested.
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
