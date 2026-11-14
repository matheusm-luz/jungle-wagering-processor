import { describe, expect, test } from 'bun:test';
import { ProviderForbiddenError } from '../../../src/application/errors';
import type { ProviderIdentityPort, UnitOfWork } from '../../../src/application/ports';
import {
  ProcessWagerTransaction,
  type ProcessWagerTransactionCommand,
} from '../../../src/application/process-wager-transaction';
import { Money } from '../../../src/domain/money';
import { WagerTransactionKind } from '../../../src/domain/wager-transaction';

const command: ProcessWagerTransactionCommand = {
  idempotencyKey: 'key-1',
  providerId: 'provider-b',
  externalTransactionId: 'tx-1',
  playerId: 'player-1',
  walletId: '0193a0c0-0000-7000-8000-000000000001',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: WagerTransactionKind.Bet,
  money: Money.from({ amount: '10.00', currency: 'BRL' }),
  correlationId: 'corr-1',
};

/** The caller is authenticated as provider-a: acting for anyone else is refused (ADR-08). */
const onlyProviderA: ProviderIdentityPort = {
  assertMayActFor(providerId) {
    if (providerId !== 'provider-a') throw new ProviderForbiddenError();
  },
};

/** Counts transactions opened; the work itself is never run. */
function countingUnitOfWork() {
  const opened = { count: 0 };
  const unitOfWork: UnitOfWork = {
    run: async () => {
      opened.count++;
      return 'duplicate' as never;
    },
  };
  return { unitOfWork, opened };
}

function useCase(unitOfWork: UnitOfWork): ProcessWagerTransaction {
  let id = 0;
  return new ProcessWagerTransaction(
    unitOfWork,
    { now: () => new Date('2026-11-14T12:00:00Z') },
    { newId: () => `0193a0c0-0000-7000-8000-${String(++id).padStart(12, '0')}` },
    onlyProviderA,
  );
}

describe('ProviderIdentityPort (ADR-08)', () => {
  test('a provider the identity port refuses is PROVIDER_FORBIDDEN and opens no transaction', async () => {
    const { unitOfWork, opened } = countingUnitOfWork();

    const refused = useCase(unitOfWork).execute(command);

    await expect(refused).rejects.toBeInstanceOf(ProviderForbiddenError);
    await expect(refused).rejects.toMatchObject({ code: 'PROVIDER_FORBIDDEN' });
    expect(opened.count).toBe(0);
  });

  test('a queue message is not checked against the caller (statement §2)', async () => {
    const { unitOfWork, opened } = countingUnitOfWork();

    await useCase(unitOfWork).executeMessage(command, {
      consumerName: 'wager-transactions',
      messageId: 'message-1',
    });

    expect(opened.count).toBe(1);
  });
});
