/** System accounts of the double-entry ledger (ADR-12). Wallets are not among them. */
export enum LedgerAccountKind {
  /** Per currency: the source of opening balances. */
  Funding = 'FUNDING',
  /** Per provider and currency: the counterparty of gameplay. */
  ProviderSettlement = 'PROVIDER_SETTLEMENT',
}

/**
 * The system account a ledger entry posts against. The repository resolves it, with the entry's
 * currency, to the account row; the domain never holds an account id.
 */
export type LedgerCounterparty =
  | { kind: LedgerAccountKind.Funding }
  | { kind: LedgerAccountKind.ProviderSettlement; providerId: string };
