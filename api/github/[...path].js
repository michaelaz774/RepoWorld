import { proxyRequest } from '../_proxy.js';

/** /api/github/* -> https://api.github.com/* with the PAT attached server-side. */
export default async function handler(req, res) {
  await proxyRequest(req, res, {
    prefix: '/api/github',
    target: 'https://api.github.com',
    headers: {
      Authorization: process.env.GITHUB_TOKEN ? `Bearer ${process.env.GITHUB_TOKEN}` : undefined,
    },
  });
}
