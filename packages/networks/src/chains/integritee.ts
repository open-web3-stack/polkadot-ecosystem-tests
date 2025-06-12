import { defaultAccounts } from '../defaultAccounts.js'
import { defineChain } from '../defineChain.js'

const custom = {
  integriteePolkadot: {
    teerP: { Concrete: { parents: 0, interior: 'Here' } },
    relayNative: 0,
  },
  integriteeKusama: {
    teerK: { Concrete: { parents: 0, interior: 'Here' } },
    relayNative: 0,
  },
}

const getInitStorages = (config: typeof custom.integriteePolkadot | typeof custom.integriteeKusama) => ({
  System: {
    account: [[[defaultAccounts.alice.address], { providers: 1, data: { free: 1000e10 } }]],
  },
  Assets: {
    account: [[[config.relayNative, defaultAccounts.alice.address], { balance: 1000e12 }]],
  },
})

export const integriteePolkadot = defineChain({
  name: 'integritee-polkadot',
  paraId: 2039,
  endpoint: 'wss://polkadot.api.integritee.network',
  custom: custom.integriteePolkadot,
  initStorages: getInitStorages(custom.integriteePolkadot),
})

export const integriteeKusama = defineChain({
  name: 'integritee-kusama',
  paraId: 2015,
  endpoint: 'wss://polkadot.api.integritee.network',
  custom: custom.integriteeKusama,
  initStorages: getInitStorages(custom.integriteeKusama),
})
