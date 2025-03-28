import { defaultAccounts, defaultAccountsSr25519 } from '../defaultAccounts.js'
import { defineChain } from '../defineChain.js'

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
    ],
  },
})

export const coretimePolkadot = defineChain({
  name: 'coretimePolkadot',
  endpoint: 'wss://polkadot-coretime-rpc.polkadot.io',
  paraId: 1005,
  custom: custom.coretimePolkadot,
  initStorages: getInitStorages(custom.coretimePolkadot),
})

export const coretimeKusama = defineChain({
  name: 'coretimeKusama',
  endpoint: 'wss://kusama-coretime-rpc.polkadot.io',
  paraId: 1005,
  custom: custom.coretimeKusama,
  initStorages: getInitStorages(custom.coretimeKusama),
})
