import { webcrypto } from 'node:crypto';

const { subtle } = webcrypto;

function toBase64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

const keyPair = await subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify']
);

const publicRaw = await subtle.exportKey('raw', keyPair.publicKey);
const privatePkcs8 = await subtle.exportKey('pkcs8', keyPair.privateKey);

const privatePem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(privatePkcs8)
  .toString('base64')
  .match(/.{1,64}/g)
  .join('\n')}\n-----END PRIVATE KEY-----`;

console.log('\nVAPID_PUBLIC_KEY=' + toBase64Url(publicRaw));
console.log('\nVAPID_PRIVATE_KEY_PEM=');
console.log(privatePem);
console.log('\nVAPID_SUBJECT=mailto:you@example.com\n');
