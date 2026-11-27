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
  westend: {
    wnd: { Concrete: { parents: 0, interior: 'Here' } },
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
  // The DMP queues are cleared by `createNetwork`, which picks the storage layout the
  // runtime has; a static entry here would name the wrong item on one side of the 2.6.0
  // paged-DMP migration.
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
    feeExtractor: standardFeeExtractor,
  },
})

// The DMP queues are cleared by `createNetwork` in whichever layout the runtime has, as for
// the other relays. The larger float covers megabyte-scale extrinsic fees; see the
// peopleWestend definition.
const getWestendInitStorages = () => ({
  System: {
    Account: [
      [[defaultAccounts.alice.address], { providers: 1, data: { free: 100_000e10 } }],
      [[defaultAccountsSr25519.alice.address], { providers: 1, data: { free: 100_000e10 } }],
      [[testAccounts.alice.address], { providers: 1, data: { free: 100_000e10 } }],
    ],
  },
  ParasDisputes: {
    // these can makes block building super slow
    $removePrefix: ['disputes'],
  },
})

export const westend = defineChain({
  name: 'westend',
  endpoint: endpoints.westend,
  custom: custom.westend,
  initStorages: getWestendInitStorages(),
  isRelayChain: true,
  networkGroup: 'westend',
  properties: {
    addressEncoding: 42,
    proxyBlockProvider: 'Local',
    schedulerBlockProvider: 'Local',
    feeExtractor: standardFeeExtractor,
  },
})
