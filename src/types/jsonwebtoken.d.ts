/**
 * Minimal ambient declaration for `jsonwebtoken`, which arrives only as a
 * transitive dependency of `bedrock-protocol` and ships no types. Only the
 * `sign` surface this project uses is declared.
 */
declare module 'jsonwebtoken' {
  export interface SignOptions {
    algorithm?: string;
    keyid?: string;
    expiresIn?: number | string;
    notBefore?: number | string;
    audience?: string | string[];
    subject?: string;
    issuer?: string;
    jwtid?: string;
    header?: Record<string, unknown>;
    noTimestamp?: boolean;
  }

  export type Secret = string | Buffer | { key: string | Buffer; passphrase: string };

  export function sign(payload: string | Buffer | Record<string, unknown>, secretOrPrivateKey: Secret, options?: SignOptions): string;

  export function decode(
    token: string,
    options?: { complete?: boolean },
  ): null | { header?: Record<string, unknown>; payload?: unknown } | string;
}
