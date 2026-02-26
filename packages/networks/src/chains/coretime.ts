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
}

const getInitStorages = (_config: typeof custom.coretimePolkadot | typeof custom.coretimeKusama) => ({
  System: {
    account: [
      [[defaultAccounts.alice.address], { providers: 1, data: { free: 1000e10 } }],
      [[defaultAccountsSr25519.alice.address], { providers: 1, data: { free: 1000e10 } }],
      [[testAccounts.alice.address], { providers: 1, data: { free: 1000e10 } }],
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
    chainEd: 'Normal',
    asyncBacking: 'Enabled',
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
    chainEd: 'LowEd',
    asyncBacking: 'Enabled',
    feeExtractor: standardFeeExtractor,
  },
})
