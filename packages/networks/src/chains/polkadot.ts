import { defaultAccounts, defaultAccountsSr25519 } from '../defaultAccounts.js'
import { defineChain } from '../defineChain.js'

const custom = {
  polkadot: {
    units: 1e10,
    dot: { Concrete: { parents: 0, interior: 'Here' } },
  },
  kusama: {
    units: 1e10,
    ksm: { Concrete: { parents: 0, interior: 'Here' } },
  },
  westend: {
    units: 1e12,
    wnd: { Concrete: { parents: 0, interior: 'Here' } },
  },
}

const getInitStorages = (config: typeof custom.polkadot | typeof custom.kusama | typeof custom.westend) => {
  const baseAmount = 1000
  const amount = BigInt(baseAmount) * BigInt(config.units)

  return {
    System: {
      Account: [
        [[defaultAccounts.alice.address], { providers: 1, data: { free: amount } }],
        [[defaultAccountsSr25519.alice.address], { providers: 1, data: { free: amount } }],
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
  }
}

export const polkadot = defineChain({
  name: 'polkadot',
  endpoint: 'wss://rpc.ibp.network/polkadot',
  custom: custom.polkadot,
  initStorages: getInitStorages(custom.polkadot),
  isRelayChain: true,
})

export const kusama = defineChain({
  name: 'kusama',
  endpoint: 'wss://rpc.ibp.network/kusama',
  custom: custom.kusama,
  initStorages: getInitStorages(custom.kusama),
  isRelayChain: true,
})

export const westend = defineChain({
  name: 'westend',
  endpoint: 'wss://rpc.ibp.network/westend',
  custom: custom.westend,
  initStorages: getInitStorages(custom.westend),
  isRelayChain: true,
})
