import { defaultAccounts, defaultAccountsSr25199 } from '../defaultAccounts.js'
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
    Account: [
      [[defaultAccounts.alice.address], { providers: 1, data: { free: 1000 * 1e10 } }],
      [[defaultAccountsSr25199.alice.address], { providers: 1, data: { free: 1000 * 1e10 } }],
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
  endpoint: 'wss://rpc.ibp.network/polkadot',
  custom: custom.polkadot,
  initStorages: getInitStorages(),
  isRelayChain: true,
})

export const kusama = defineChain({
  name: 'kusama',
  endpoint: 'wss://rpc.ibp.network/kusama',
  custom: custom.kusama,
  initStorages: getInitStorages(),
  isRelayChain: true,
})
