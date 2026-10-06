import { buildPushPayload, type PushSubscription } from '@block65/webcrypto-web-push';
import { type Env, json } from '../_lib/types';

interface SendBody {
  code?: string;
  title?: string;
  body?: string;
  url?: string;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const { code, title, body, url } = (await request.json()) as SendBody;

  if (!code) return json({ error: 'Pairing code is required' }, 400);
  if (!title?.trim()) return json({ error: 'Title is required' }, 400);

  const stored = await env.SUBS.get(`sub:${code}`);
  if (!stored) return json({ error: 'Unknown or expired pairing code' }, 404);

  const payload = await buildPushPayload(
    { data: JSON.stringify({ title, body: body ?? '', url: url ?? '/' }), options: { ttl: 60 } },
    JSON.parse(stored) as PushSubscription,
    {
      subject: env.VAPID_SUBJECT,
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
    },
  );

  const res = await fetch(JSON.parse(stored).endpoint, payload);
  if (!res.ok) return json({ error: `Push service returned ${res.status}` }, 502);
  return json({ ok: true });
};
