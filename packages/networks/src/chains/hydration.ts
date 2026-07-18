import { standardFeeExtractor } from '@e2e-test/shared'

import { defineChain } from '../defineChain.js'
import endpoints from '../pet-chain-endpoints.json' with { type: 'json' }
import { defaultAccounts, defaultAccountsSr25519 } from '../testAccounts.js'

const custom = {
  hydration: {
    dai: 2,
    relayToken: 5,
    glmr: 16,
  },
  basilisk: {
    bsx: 0,
    dai: 13,
    relayToken: 1,
  },
}

const getInitStorages = (config: typeof custom.hydration | typeof custom.basilisk) => ({
  System: {
    Account: [[[defaultAccountsSr25519.alice.address], { providers: 1, data: { free: 10n ** 18n } }]],
  },
  Tokens: {
    Accounts: [
      [[defaultAccountsSr25519.alice.address, config.relayToken], { free: 1000 * 1e12 }],
      [[defaultAccounts.alice.address, config.dai], { free: 100n * 10n ** 18n }],
    ],
  },
  // MultiTransactionPayment.on_initialize iterates every AcceptedCurrencies entry (~91 on
  // Hydration) and writes an AcceptedCurrencyPrice per entry, each block. Against a fork that is
  // ~184 remote getKeysPaged calls per block, the bulk of the RPC traffic that makes bootstrap
  // sensitive to transient upstream stalls. The fee-currency data is unused by these tests, so
  // elide both maps; an exact-prefix removal lets the runtime iteration resolve locally instead
  // of walking the upstream endpoint.
  MultiTransactionPayment: {
    $removePrefix: ['acceptedCurrencies', 'acceptedCurrencyPrice'],
  },
})

export const hydration = defineChain({
  name: 'hydration',
  paraId: 2034,
  endpoint: endpoints.hydration,
  networkGroup: 'polkadot',
  custom: custom.hydration,
  initStorages: getInitStorages(custom.hydration),
  properties: {
    addressEncoding: 0,
    schedulerBlockProvider: 'Local',
    relayBlocksPerParaBlock: 2,
    feeExtractor: standardFeeExtractor,
  },
})

export const basilisk = defineChain({
  name: 'basilisk',
  paraId: 2090,
  endpoint: endpoints.basilisk,
  networkGroup: 'kusama',
  custom: custom.basilisk,
  initStorages: getInitStorages(custom.basilisk),
  properties: {
    addressEncoding: 10041,
    schedulerBlockProvider: 'Local',
    relayBlocksPerParaBlock: 2,
    feeExtractor: standardFeeExtractor,
  },
})
