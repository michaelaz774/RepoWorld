import { proxyRequest } from '../_proxy.js';

/** /api/skybox/* -> https://backend.blockadelabs.com/* with the Blockade key attached.
 *  Optional: with no key set the app falls back to the procedural voxel sky. */
export default async function handler(req, res) {
  await proxyRequest(req, res, {
    prefix: '/api/skybox',
    target: 'https://backend.blockadelabs.com',
    headers: { 'x-api-key': process.env.BLOCKADE_API_KEY },
  });
}
