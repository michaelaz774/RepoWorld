import { proxyRequest } from '../_proxy.js';

/** /api/greptile/* -> https://api.greptile.com/* with both auth headers attached. */
export default async function handler(req, res) {
  await proxyRequest(req, res, {
    prefix: '/api/greptile',
    target: 'https://api.greptile.com',
    headers: {
      Authorization: process.env.GREPTILE_API_KEY
        ? `Bearer ${process.env.GREPTILE_API_KEY}`
        : undefined,
      // Greptile needs a GitHub token to index the target repository.
      'X-GitHub-Token': process.env.GITHUB_TOKEN,
    },
  });
}
