import { generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

const target = '.dev.vars';
if (existsSync(target)) {
  console.log(`${target} already exists, not overwriting`);
  process.exit(0);
}

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pub = publicKey.export({ format: 'jwk' });
const priv = privateKey.export({ format: 'jwk' });

const b64u = (buf: Buffer) => buf.toString('base64url');
const rawPublic = Buffer.concat([
  Buffer.from([0x04]),
  Buffer.from(pub.x!, 'base64url'),
  Buffer.from(pub.y!, 'base64url'),
]);

writeFileSync(
  target,
  [
    `VAPID_SUBJECT=mailto:demo@example.com`,
    `VAPID_PUBLIC_KEY=${b64u(rawPublic)}`,
    `VAPID_PRIVATE_KEY=${priv.d}`,
    '',
  ].join('\n'),
);
console.log(`Wrote ${target}`);
