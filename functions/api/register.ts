import { type Env, json } from '../_lib/types';

const TTL_SECONDS = 60 * 60;

// Receiver device posts its push subscription and gets a short pairing code.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const { subscription } = (await request.json()) as { subscription?: { endpoint?: string } };
  if (!subscription?.endpoint) return json({ error: 'subscription required' }, 400);

  const code = String(Math.floor(100000 + Math.random() * 900000));
  await env.SUBS.put(`sub:${code}`, JSON.stringify(subscription), { expirationTtl: TTL_SECONDS });
  return json({ code });
};
