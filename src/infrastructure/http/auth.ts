import { type CanActivate, Injectable } from '@nestjs/common';
import type { ProviderIdentityPort } from '../../application/ports';

/**
 * ADR-08, ARCHITECTURE §8: where a provider's JWT would be verified (signature against the realm's
 * JWKS, issuer, audience, scope) and its provider id kept for `ProviderIdentityPort`. It is global,
 * so a real implementation must exempt `/health/*` and `/metrics`, which stay open (statement §2).
 * Authentication is not implemented, so every request passes.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

/** The identity bound while there is no IdP: the caller may act for any provider. */
export const ANY_PROVIDER: ProviderIdentityPort = { assertMayActFor: () => {} };
