import { standardFeeExtractor } from '@e2e-test/shared'

import { defineChain } from '../defineChain.js'
import endpoints from '../pet-chain-endpoints.json' with { type: 'json' }
import { defaultAccounts, defaultAccountsSr25519, testAccounts } from '../testAccounts.js'

const custom = {
  coretimePolkadot: {
    dot: { Concrete: { parents: 1, interior: 'Here' } },
  },
  coretimeKusama: {
    ksm: { Concrete: { parents: 1, interior: 'Here' } },
  },
  coretimeWestend: {
    wnd: { Concrete: { parents: 1, interior: 'Here' } },
  },
}

const getInitStorages = (
  _config: typeof custom.coretimePolkadot | typeof custom.coretimeKusama | typeof custom.coretimeWestend,
  free = 1000e10,
) => ({
  System: {
    account: [
      [[defaultAccounts.alice.address], { providers: 1, data: { free } }],
      [[defaultAccountsSr25519.alice.address], { providers: 1, data: { free } }],
      [[testAccounts.alice.address], { providers: 1, data: { free } }],
    ],
  },
})

export const coretimePolkadot = defineChain({
  name: 'coretimePolkadot',
  endpoint: endpoints.coretimePolkadot,
  paraId: 1005,
  networkGroup: 'polkadot',
  custom: custom.coretimePolkadot,
  initStorages: getInitStorages(custom.coretimePolkadot),
  properties: {
    addressEncoding: 0,
    proxyBlockProvider: 'Local',
    schedulerBlockProvider: 'NonLocal',
    relayBlocksPerParaBlock: 2,
    feeExtractor: standardFeeExtractor,
  },
})

export const coretimeKusama = defineChain({
  name: 'coretimeKusama',
  endpoint: endpoints.coretimeKusama,
  paraId: 1005,
  networkGroup: 'kusama',
  custom: custom.coretimeKusama,
  initStorages: getInitStorages(custom.coretimeKusama),
  properties: {
    addressEncoding: 2,
    proxyBlockProvider: 'Local',
    schedulerBlockProvider: 'NonLocal',
    relayBlocksPerParaBlock: 2,
    feeExtractor: standardFeeExtractor,
  },
})

export const coretimeWestend = defineChain({
  name: 'coretimeWestend',
  endpoint: endpoints.coretimeWestend,
  paraId: 1005,
  networkGroup: 'westend',
  custom: custom.coretimeWestend,
  // See peopleWestend: Westend fee levels ask for a larger float on the dev accounts.
  initStorages: getInitStorages(custom.coretimeWestend, 100_000e10),
  properties: {
    addressEncoding: 42,
    proxyBlockProvider: 'Local',
    schedulerBlockProvider: 'NonLocal',
    relayBlocksPerParaBlock: 2,
    feeExtractor: standardFeeExtractor,
  },
})
