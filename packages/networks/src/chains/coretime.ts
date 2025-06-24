import { defaultAccounts, defaultAccountsSr25519 } from '../defaultAccounts.js'
import { defineChain } from '../defineChain.js'

const custom = {
  coretimePolkadot: {
    units: 1e10,
    dot: { Concrete: { parents: 1, interior: 'Here' } },
  },
  coretimeKusama: {
    units: 1e10,
    ksm: { Concrete: { parents: 1, interior: 'Here' } },
  },
  coretimeWestend: {
    units: 1e12,
    wnd: { Concrete: { parents: 1, interior: 'Here' } },
  },
}

const getInitStorages = (
  config: typeof custom.coretimePolkadot | typeof custom.coretimeKusama | typeof custom.coretimeWestend,
) => {
  const baseAmount = 1000
  const amount = BigInt(baseAmount) * BigInt(config.units)

  return {
    System: {
      account: [
        [[defaultAccountsSr25519.alice.address], { providers: 1, data: { free: amount } }],
        [[defaultAccounts.alice.address], { providers: 1, data: { free: amount } }],
      ],
    },
  }
}

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

export const coretimeWestend = defineChain({
  name: 'coretimeWestend',
  endpoint: 'wss://westend-coretime-rpc.polkadot.io',
  paraId: 1005,
  custom: custom.coretimeWestend,
  initStorages: getInitStorages(custom.coretimeWestend),
})
