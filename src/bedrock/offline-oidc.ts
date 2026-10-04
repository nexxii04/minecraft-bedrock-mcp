import { createRequire } from 'node:module';

import type { Logger } from '../logger.js';
import type { sign as jwtSign } from 'jsonwebtoken';

/**
 * `jsonwebtoken` is a transitive dependency of `bedrock-protocol` (it ships no
 * types; see `src/types/jsonwebtoken.d.ts`). Resolving it through the CJS
 * require hook keeps it out of this project's own dependency list while
 * staying ESM-safe.
 */
const requireCjs = createRequire(import.meta.url);
const jsonwebtoken = requireCjs('jsonwebtoken') as { sign: typeof jwtSign };

/**
 * Interop shim for Bedrock servers whose offline login parses the *OIDC* identity
 * token (the 1.21.90+ `AuthenticationType: 2` format).
 *
 * `bedrock-protocol`, connecting offline with protocol >= 944, signs the
 * multiplayer token with `{ cpk, xid, xname, identity, leguuid, mid, iss, aud,
 * nbf, exp }`. Some third-party servers expect the full Xbox identity triple —
 * `xid` (xuid), `xname` (gamertag) and `tid` (title id). Because the token carries
 * `cpk` it is decoded through the OIDC path, and a missing `tid` fails the parse:
 * the server logs `Login field 'tid' is missing` and answers `play_status:
 * failed_client`.
 *
 * The shim decodes the payload, adds the missing claim(s) and re-signs with the
 * SAME key pair and header the client already uses, so the signature chain and the
 * `x5u` key reference stay valid: private key is the client's EC P-384 pair, and
 * the header keeps `x5u: <clientX509>` with `alg` ES384 and `typ` omitted.
 *
 * The claimed identity does not change (`xname`/`xid` copied verbatim), so offline
 * uuid derivation is unaffected. `tid` only identifies the Xbox title; for a
 * self-signed offline login there is none, and `0` is the neutral value.
 */

/** Claims the shim can add when the server requires them. */
export interface OidcOfflineClaims {
  /** Xbox title id. Present but `0` for self-signed offline logins. */
  tid?: string;
}

/** The exact options `bedrock-protocol` passes to `JWT.sign` for this token. */
const SIGN_OPTIONS = {
  algorithm: 'ES384' as const,
  notBefore: 0,
  issuer: 'self',
  expiresIn: 60 * 60,
  audience: 'api://auth-minecraft-services/multiplayer',
};

/** Registered claims the original token carries (and we must not duplicate). */
const ORIGINAL_LIFETIME_CLAIMS = ['exp', 'nbf', 'iat'] as const;

interface JwtParts {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: string;
  signingInput: string;
}

function decodeJwt(token: string): JwtParts | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, signature] = parts as [string, string, string];
  try {
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as Record<string, unknown>;
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Record<string, unknown>;
    return { header, payload, signature, signingInput: `${encodedHeader}.${encodedPayload}` };
  } catch {
    return null;
  }
}

/**
 * Decides whether a token is the OIDC offline identity token. It must carry the
 * client public key (`cpk`), which pushes servers down the OIDC parse path, and
 * already claim an identity (`xname`).
 */
export function isOidcOfflineToken(token: string): boolean {
  const decoded = decodeJwt(token);
  if (decoded === null) return false;
  return typeof decoded.payload['cpk'] === 'string' && typeof decoded.payload['xname'] === 'string';
}

export interface ResignResult {
  token: string;
  /** True when the shim re-signed the token; false when it passed through unchanged. */
  modified: boolean;
  addedClaims: string[];
}

/**
 * Re-signs the OIDC offline token with the extra claims a server requires. Returns
 * the input unchanged when it is not an OIDC offline token, the claims are already
 * present, or the key is unavailable.
 */
export function resignOidcOfflineToken(
  token: string,
  claims: OidcOfflineClaims,
  context: { privateKeyPem: string; clientX509: string; logger: Logger },
): ResignResult {
  const decoded = decodeJwt(token);
  if (decoded === null) return { token, modified: false, addedClaims: [] };
  if (!isOidcOfflineToken(token)) return { token, modified: false, addedClaims: [] };

  const missing = (Object.keys(claims) as (keyof OidcOfflineClaims)[]).filter((claim) => {
    const value = claims[claim];
    if (value === undefined) return false;
    return decoded.payload[claim] !== value;
  });
  if (missing.length === 0) return { token, modified: false, addedClaims: [] };

  // `jsonwebtoken` rejects registered-claim OPTIONS when the payload already has
  // them, and the original payload has every registered claim baked in. So strip
  // the timestamp claims and pass the rest through the payload; `sign` then needs
  // only the header, matching the library's token 1:1.
  const payload: Record<string, unknown> = { ...decoded.payload };
  for (const claim of missing) payload[claim] = claims[claim];
  for (const claim of ORIGINAL_LIFETIME_CLAIMS) delete payload[claim];

  let signed: string;
  try {
    signed = jsonwebtoken.sign(payload, context.privateKeyPem, {
      algorithm: 'ES384',
      expiresIn: SIGN_OPTIONS.expiresIn,
      header: { x5u: context.clientX509, typ: undefined },
    });
  } catch (error) {
    context.logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'failed to re-sign offline OIDC token; sending it unmodified',
    );
    return { token, modified: false, addedClaims: [] };
  }

  context.logger.debug({ addedClaims: missing }, 're-signed offline OIDC token');
  return { token: signed, modified: true, addedClaims: missing };
}

/** The claims this project adds, as a frozen record for tests and callers. */
export const OFFLINE_OIDC_CLAIMS: OidcOfflineClaims = Object.freeze({ tid: '0' });

/** How long the re-signed token lives, mirrored from the library's own choice. */
export const OIDC_TOKEN_TTL_MS = SIGN_OPTIONS.expiresIn * 1000;
