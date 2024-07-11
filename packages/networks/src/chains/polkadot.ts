import { defaultAccount } from '@e2e-test/shared'

import { defineChain } from '../defineChain.js'

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
    Account: [[[defaultAccount.alice.address], { providers: 1, data: { free: 10 * 1e12 } }]],
  },
  ParasDisputes: {
    // those can makes block building super slow
    $removePrefix: ['disputes'],
  },
  Dmp: {
    // clear existing dmp to avoid impact test result
    $removePrefix: ['downwardMessageQueues'],
  },
})

export const polkadot = defineChain({
  name: 'polkadot',
  endpoint: 'wss://polkadot-rpc.dwellir.com',
  custom: custom.polkadot,
  initStorages: getInitStorages(),
  isRelayChain: true,
})

export const kusama = defineChain({
  name: 'kusama',
  endpoint: 'wss:///kusama-rpc.dwellir.com',
  custom: custom.kusama,
  initStorages: getInitStorages(),
  isRelayChain: true,
})
