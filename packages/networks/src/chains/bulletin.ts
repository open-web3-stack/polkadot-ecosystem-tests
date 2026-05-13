import { standardFeeExtractor } from '@e2e-test/shared'

import { defineChain } from '../defineChain.js'
import endpoints from '../pet-chain-endpoints.json' with { type: 'json' }
import { defaultAccounts, defaultAccountsSr25519, testAccounts } from '../testAccounts.js'

const custom = {
  bulletinPolkadot: {
    dot: { Concrete: { parents: 1, interior: 'Here' } },
  },
}

// `pallet_collator_selection`'s `StakingPotAccountId` (= `PalletId(*b"PotStake").into_account_truncating()`).
// `DealWithFees` routes all transaction fees to this account via `ResolveTo`. If the pot account does not
// exist on-chain (providers == 0), the routed credit is silently dropped and the equivalent value is burned
// from `TotalIssuance` instead. Seeding it here prevents that burn so the burn-test assertions hold.
const STAKING_POT = '13UVJyLgBASGhE2ok3TvxUfaQBGUt88JCcdYjHvUhvQkFTTx'

// Bulletin Polkadot's live genesis preset endows no accounts, so the live chain has `TotalIssuance == 0`:
// https://github.com/polkadot-fellows/runtimes/blob/c8603f3f844bb4084149f2ec332134bb274e21c6/system-parachains/bulletin/bulletin-polkadot/src/genesis_config_presets.rs#L56-L57
// The `fungible` API's `withdraw_fee` mutates `TotalIssuance` via checked arithmetic, so any signed
// extrinsic underflows during fee withdrawal and is rejected with `InvalidTransaction::Payment` before it
// reaches dispatch. The `Balances.totalIssuance` override below must cover the sum of all `System.Account`
// balances seeded above (4 test accounts + the staking pot, each with 1000e10 → 5000e10 total).
const getInitStorages = (_config: typeof custom.bulletinPolkadot) => ({
  System: {
    account: [
      [[defaultAccountsSr25519.alice.address], { providers: 1, data: { free: 1000e10 } }],
      [[defaultAccounts.alice.address], { providers: 1, data: { free: 1000e10 } }],
      [[defaultAccounts.bob.address], { providers: 1, data: { free: 1000e10 } }],
      [[testAccounts.alice.address], { providers: 1, data: { free: 1000e10 } }],
      [[STAKING_POT], { providers: 1, data: { free: 1000e10 } }],
    ],
  },
  Balances: {
    totalIssuance: 5000e10,
  },
})

export const bulletinPolkadot = defineChain({
  name: 'bulletinPolkadot',
  endpoint: endpoints.bulletinPolkadot,
  paraId: 1010,
  networkGroup: 'polkadot',
  custom: custom.bulletinPolkadot,
  initStorages: getInitStorages(custom.bulletinPolkadot),
  properties: {
    addressEncoding: 0,
    proxyBlockProvider: 'Local',
    schedulerBlockProvider: 'NonLocal',
    asyncBacking: 'Enabled',
    feeExtractor: standardFeeExtractor,
  },
})
