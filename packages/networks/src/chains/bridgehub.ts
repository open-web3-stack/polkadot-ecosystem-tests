import { defaultAccounts } from '../defaultAccounts.js'
import { defineChain } from '../defineChain.js'

const custom = {
  bridgeHubPolkadot: {
    dot: { Concrete: { parents: 1, interior: 'Here' } },
  },
  bridgeHubKusama: {
    ksm: { Concrete: { parents: 1, interior: 'Here' } },
  },
  bridgeHubWestend: {
    wnd: { Concrete: { parents: 1, interior: 'Here' } },
  },
}

const getInitStorages = (
  _config: typeof custom.bridgeHubPolkadot | typeof custom.bridgeHubKusama | typeof custom.bridgeHubWestend,
) => ({
  System: {
    account: [[[defaultAccounts.alice.address], { providers: 1, data: { free: 1000e10 } }]],
  },
})

export const bridgeHubPolkadot = defineChain({
  name: 'bridgeHubPolkadot',
  endpoint: 'wss://polkadot-bridge-hub-rpc.polkadot.io',
  paraId: 1002,
  custom: custom.bridgeHubPolkadot,
  initStorages: getInitStorages(custom.bridgeHubPolkadot),
})

export const bridgeHubKusama = defineChain({
  name: 'bridgeHubKusama',
  endpoint: 'wss://kusama-bridge-hub-rpc.polkadot.io',
  paraId: 1002,
  custom: custom.bridgeHubKusama,
  initStorages: getInitStorages(custom.bridgeHubKusama),
})

export const bridgeHubWestend = defineChain({
  name: 'bridgeHubWestend',
  endpoint: 'wss://westend-bridge-hub-rpc.polkadot.io',
  paraId: 1002,
  custom: custom.bridgeHubWestend,
  initStorages: getInitStorages(custom.bridgeHubWestend),
})
