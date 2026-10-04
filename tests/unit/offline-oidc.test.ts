import { createRequire } from 'node:module';
import { createVerify, generateKeyPairSync, createPublicKey } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { OFFLINE_OIDC_CLAIMS, isOidcOfflineToken, resignOidcOfflineToken } from '../../src/bedrock/offline-oidc.js';
import { createNoopLogger } from '../../src/logger.js';

/**
 * Tests for the offline OIDC re-signing shim. `jsonwebtoken` is available
 * transitively, so these exercise the real signing path with a throwaway P-384 key
 * pair — the same curve the library generates for its clients.
 */

const logger = createNoopLogger();
// Vitest's CJS interop may wrap the module in `{ default }`; handle both shapes.
const jwtModule = createRequire(import.meta.url)('jsonwebtoken') as {
  sign?: (payload: Record<string, unknown>, key: string, options?: Record<string, unknown>) => string;
  default?: { sign?: (payload: Record<string, unknown>, key: string, options?: Record<string, unknown>) => string };
};
const jwtSign = jwtModule.sign ?? jwtModule.default?.sign;
if (typeof jwtSign !== 'function') throw new Error('jsonwebtoken.sign unavailable');
const signJwt = jwtSign;

function makeKeyPair(): { privateKeyPem: string; clientX509: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'sec1' }).toString(),
    clientX509: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
}

function decodeHeader(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** Builds the base OIDC token the same way bedrock-protocol does (claims only it sets). */
function makeOidcToken(context: { privateKeyPem: string; clientX509: string }): string {
  const payload = {
    cpk: context.clientX509,
    xid: '0',
    xname: 'UnitAgent',
    identity: '00000000-0000-0000-0000-000000000000',
    leguuid: '00000000-0000-0000-0000-000000000000',
    mid: '',
    iss: 'self',
    aud: 'api://auth-minecraft-services/multiplayer',
    nbf: Math.floor(Date.now() / 1000) - 5,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  return signJwt(payload, context.privateKeyPem, {
    algorithm: 'ES384',
    header: { x5u: context.clientX509, typ: undefined },
  });
}

function verifyEs384(publicKey: ReturnType<typeof createPublicKey>, data: string, derSignature: Buffer): boolean {
  try {
    return createVerify('SHA384').update(data).verify(publicKey, derSignature);
  } catch {
    return false;
  }
}

/** Wraps raw r||s ECDSA halves into an ASN.1 DER ECDSA-Sig-Value. */
function derFromRaw(r: Buffer, s: Buffer): Buffer {
  const pad = (value: Buffer): Buffer => {
    if (value[0]! >= 0x80) return Buffer.concat([Buffer.from([0x00]), value]);
    // Strip leading zeros but keep at least one byte.
    let start = 0;
    while (start < value.length - 1 && value[start] === 0) start += 1;
    return value.subarray(start);
  };
  const rDer = pad(r);
  const sDer = pad(s);
  const header = Buffer.from([0x30, 4 + rDer.length + sDer.length]);
  const rPart = Buffer.concat([Buffer.from([0x02, rDer.length]), rDer]);
  const sPart = Buffer.concat([Buffer.from([0x02, sDer.length]), sDer]);
  return Buffer.concat([header, rPart, sPart]);
}

describe('offline OIDC shim', () => {
  it('detects OIDC offline tokens by their cpk and xname claims', () => {
    const context = makeKeyPair();
    const token = makeOidcToken(context);
    expect(isOidcOfflineToken(token)).toBe(true);
    expect(isOidcOfflineToken('garbage')).toBe(false);
    expect(isOidcOfflineToken('a.b.c')).toBe(false);
  });

  it('adds the tid claim and keeps the identity claims intact', () => {
    const context = makeKeyPair();
    const token = makeOidcToken(context);
    const result = resignOidcOfflineToken(token, OFFLINE_OIDC_CLAIMS, { ...context, logger });

    expect(result.modified).toBe(true);
    expect(result.addedClaims).toEqual(['tid']);

    const payload = decodePayload(result.token);
    expect(payload['tid']).toBe('0');
    expect(payload['xname']).toBe('UnitAgent');
    expect(payload['xid']).toBe('0');
    expect(payload['cpk']).toBe(context.clientX509);
  });

  it('re-signs with the same key and x5u header the client uses', () => {
    const context = makeKeyPair();
    const token = makeOidcToken(context);
    const result = resignOidcOfflineToken(token, OFFLINE_OIDC_CLAIMS, { ...context, logger });

    const header = decodeHeader(result.token);
    expect(header['alg']).toBe('ES384');
    expect(header['x5u']).toBe(context.clientX509);

    // The signature must verify against the client's public key. jsonwebtoken
    // signs with the SEC1/PKCS#8 PEM we hand it; the DER SPKI public key is the
    // same key material, so a JOSE-style verify must succeed.
    const [encodedHeader, encodedPayload, signature] = result.token.split('.') as [string, string, string];
    const jws = `${encodedHeader}.${encodedPayload}`;
    const derSignature = Buffer.from(signature, 'base64url');
    // JWT ECDSA signatures are raw r||s; Node wants DER, so convert.
    const raw = derSignature.length % 2 === 0 ? derSignature : derSignature.subarray(1);
    const half = raw.length / 2;
    const r = raw.subarray(0, half);
    const s = raw.subarray(half);
    const der = derFromRaw(r, s);
    const publicKey = createPublicKey({ key: Buffer.from(context.clientX509, 'base64'), format: 'der', type: 'spki' });
    expect(verifyEs384(publicKey, jws, der)).toBe(true);
  });

  it('passes tokens through unchanged when the claims are already present', () => {
    const context = makeKeyPair();
    const token = makeOidcToken(context);
    // First pass adds tid; a second pass must be a no-op.
    const first = resignOidcOfflineToken(token, OFFLINE_OIDC_CLAIMS, { ...context, logger });
    const second = resignOidcOfflineToken(first.token, OFFLINE_OIDC_CLAIMS, { ...context, logger });
    expect(second.modified).toBe(false);
    expect(second.token).toBe(first.token);
  });

  it('does not touch non-OIDC tokens (legacy offline format, online mode)', () => {
    const context = makeKeyPair();
    const legacy = jwtSign(
      { extraData: { displayName: 'UnitAgent', XUID: '0' }, identityPublicKey: context.clientX509 },
      context.privateKeyPem,
      { algorithm: 'ES384' },
    );
    const result = resignOidcOfflineToken(legacy, OFFLINE_OIDC_CLAIMS, { ...context, logger });
    expect(result.modified).toBe(false);
    expect(result.token).toBe(legacy);
  });
});
