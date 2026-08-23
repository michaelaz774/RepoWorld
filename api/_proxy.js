/**
 * Shared upstream proxy for Vercel serverless functions.
 *
 * In local dev, `vite.config.js`'s `server.proxy` handles /api/* and injects the auth
 * headers. That proxy does NOT exist in a Vercel deployment (the build is static files on
 * a CDN), so these functions reproduce it at the edge. Keep the two in sync: same paths,
 * same injected headers, same upstreams.
 *
 * Secrets are read from process.env at request time and never reach the browser.
 */

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {{ prefix: string, target: string, headers: Record<string, string|undefined> }} opts
 */
export async function proxyRequest(req, res, opts) {
  const { prefix, target, headers } = opts;

  try {
    // req.url is the full path incl. query, e.g. /api/github/repos/a/b?recursive=1
    const rawUrl = req.url || '';
    const suffix = rawUrl.startsWith(prefix) ? rawUrl.slice(prefix.length) : rawUrl;
    const upstreamUrl = target + (suffix.startsWith('/') ? suffix : '/' + suffix);

    const outHeaders = { Accept: 'application/json', 'User-Agent': 'repo-world' };
    for (const [k, v] of Object.entries(headers)) {
      if (v) outHeaders[k] = v;
    }

    const method = req.method || 'GET';
    let body;
    if (method !== 'GET' && method !== 'HEAD') {
      // Vercel pre-parses JSON bodies onto req.body.
      if (req.body != null) {
        body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        outHeaders['Content-Type'] = 'application/json';
      }
    }

    const upstream = await fetch(upstreamUrl, { method, headers: outHeaders, body });
    const text = await upstream.text();

    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    // These responses are per-repo and change; don't let the CDN pin them.
    res.setHeader('Cache-Control', 'no-store');
    res.send(text);
  } catch (err) {
    res.status(502);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ error: 'upstream_failed', detail: String(err?.message || err) }));
  }
}
