import { standardFeeExtractor } from '@e2e-test/shared'

import { defineChain } from '../defineChain.js'
import endpoints from '../pet-chain-endpoints.json' with { type: 'json' }
import { defaultAccounts, defaultAccountsSr25519, testAccounts } from '../testAccounts.js'

const custom = {
  collectivesPolkadot: {
    dot: { Concrete: { parents: 1, interior: 'Here' } },
  },
  collectivesWestend: {
    wnd: { Concrete: { parents: 1, interior: 'Here' } },
  },
}

const getInitStorages = (_config: typeof custom.collectivesPolkadot) => ({
  System: {
    account: [
      [[defaultAccountsSr25519.alice.address], { providers: 1, data: { free: 1000e10 } }],
      [[defaultAccounts.alice.address], { providers: 1, data: { free: 1000e10 } }],
      [[defaultAccounts.bob.address], { providers: 1, data: { free: 1000e10 } }],
      [[testAccounts.alice.address], { providers: 1, data: { free: 1000e10 } }],
    ],
  },
})

export const collectivesPolkadot = defineChain({
  name: 'collectivesPolkadot',
  endpoint: endpoints.collectivesPolkadot,
  paraId: 1001,
  networkGroup: 'polkadot',
  custom: custom.collectivesPolkadot,
  initStorages: getInitStorages(custom.collectivesPolkadot),
  properties: {
    addressEncoding: 0,
    proxyBlockProvider: 'Local',
    schedulerBlockProvider: 'Local',
    relayBlocksPerParaBlock: 2,
    feeExtractor: standardFeeExtractor,
  },
})

// Collectives Westend (SS58: 42). Blocks are 6 seconds, one per relay chain block. Its proxy and
// scheduler pallets count local block numbers. No accounts are seeded here: suites fund the
// accounts they sign with.
export const collectivesWestend = defineChain({
  name: 'collectivesWestend',
  endpoint: endpoints.collectivesWestend,
  paraId: 1001,
  networkGroup: 'westend',
  custom: custom.collectivesWestend,
  properties: {
    addressEncoding: 42,
    proxyBlockProvider: 'Local',
    schedulerBlockProvider: 'Local',
    relayBlocksPerParaBlock: 1,
    feeExtractor: standardFeeExtractor,
  },
})
