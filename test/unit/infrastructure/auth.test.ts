import { describe, expect, test } from 'bun:test';
import { APP_GUARD } from '@nestjs/core';
import { AppModule } from '../../../src/app.module';
import { PROVIDER_IDENTITY } from '../../../src/application/tokens';
import { loadEnv } from '../../../src/config/env';
import { ANY_PROVIDER, AuthGuard } from '../../../src/infrastructure/http/auth';
import { JsonLogger } from '../../../src/infrastructure/logging/json-logger';

describe('authentication extension point (ADR-08)', () => {
  test('the AuthGuard is global and lets every request through, and the bound identity accepts any provider', () => {
    const env = loadEnv({ DATABASE_URL: 'postgresql://wagering:wagering@localhost:5432/wagering' });
    const providers = AppModule.forRoot(env, new JsonLogger({ level: 'silent' })).providers ?? [];

    expect(providers).toContainEqual({ provide: APP_GUARD, useClass: AuthGuard });
    expect(providers).toContainEqual({ provide: PROVIDER_IDENTITY, useValue: ANY_PROVIDER });
    expect(new AuthGuard().canActivate()).toBe(true);
    expect(() => ANY_PROVIDER.assertMayActFor('any-provider')).not.toThrow();
  });
});
