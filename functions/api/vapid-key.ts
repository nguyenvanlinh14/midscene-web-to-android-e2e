import { type Env, json } from '../_lib/types';

export const onRequestGet: PagesFunction<Env> = async ({ env }) =>
  json({ publicKey: env.VAPID_PUBLIC_KEY });
