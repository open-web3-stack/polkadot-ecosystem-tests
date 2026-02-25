import { standardFeeExtractor } from '@e2e-test/shared'

import { defineChain } from '../defineChain.js'
import endpoints from '../pet-chain-endpoints.json' with { type: 'json' }
import { defaultAccounts, defaultAccountsSr25519, testAccounts } from '../testAccounts.js'

const custom = {
  polkadot: {
    dot: { Concrete: { parents: 0, interior: 'Here' } },
  },
  kusama: {
    ksm: { Concrete: { parents: 0, interior: 'Here' } },
  },
}

const getInitStorages = () => ({
  System: {
    Account: [
      [[defaultAccounts.alice.address], { providers: 1, data: { free: 1000 * 1e10 } }],
      [[defaultAccountsSr25519.alice.address], { providers: 1, data: { free: 1000 * 1e10 } }],
      [[testAccounts.alice.address], { providers: 1, data: { free: 1000 * 1e10 } }],
    ],
  },
  ParasDisputes: {
    // these can makes block building super slow
    $removePrefix: ['disputes'],
  },
  Dmp: {
    // clear existing dmp to avoid impacting test result
    $removePrefix: ['downwardMessageQueues'],
  },
})

export const polkadot = defineChain({
  name: 'polkadot',
  endpoint: endpoints.polkadot,
  custom: custom.polkadot,
  initStorages: getInitStorages(),
  isRelayChain: true,
  networkGroup: 'polkadot',
  properties: {
    addressEncoding: 0,
    proxyBlockProvider: 'Local',
    schedulerBlockProvider: 'Local',
    chainEd: 'Normal',
    feeExtractor: standardFeeExtractor,
  },
})

export const kusama = defineChain({
  name: 'kusama',
  endpoint: endpoints.kusama,
  custom: custom.kusama,
  initStorages: getInitStorages(),
  isRelayChain: true,
  networkGroup: 'kusama',
  properties: {
    addressEncoding: 2,
    proxyBlockProvider: 'Local',
    schedulerBlockProvider: 'Local',
    chainEd: 'LowEd',
    feeExtractor: standardFeeExtractor,
  },
})
