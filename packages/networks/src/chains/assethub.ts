import { defaultAccounts } from '../defaultAccounts.js'
import { defineChain } from '../defineChain.js'

const custom = {
  assetHubPolkadot: {
    dot: { Concrete: { parents: 1, interior: 'Here' } },
    usdt: { Concrete: { parents: 0, interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: 1984 }] } } },
    usdtIndex: 1984,
  },
  assetHubKusama: {
    ksm: { Concrete: { parents: 1, interior: 'Here' } },
    usdt: { Concrete: { parents: 0, interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: 1984 }] } } },
    usdtIndex: 1984,
  },
  assetHubWestend: {
    wnd: { Concrete: { parents: 1, interior: 'Here' } },
    usdt: { Concrete: { parents: 0, interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: 1984 }] } } },
    usdtIndex: 1984,
  },
}

const getInitStorages = (
  config: typeof custom.assetHubPolkadot | typeof custom.assetHubKusama | typeof custom.assetHubWestend,
) => ({
  System: {
    account: [[[defaultAccounts.alice.address], { providers: 1, data: { free: 1000e10 } }]],
  },
  Assets: {
    account: [
      [[config.usdtIndex, defaultAccounts.alice.address], { balance: 1000e6 }], // USDT
    ],
  },
})

export const assetHubPolkadot = defineChain({
  name: 'assetHubPolkadot',
  endpoint: 'wss://polkadot-asset-hub-rpc.polkadot.io',
  paraId: 1000,
  custom: custom.assetHubPolkadot,
  initStorages: getInitStorages(custom.assetHubPolkadot),
})

export const assetHubKusama = defineChain({
  name: 'assetHubKusama',
  endpoint: 'wss://kusama-asset-hub-rpc.polkadot.io',
  paraId: 1000,
  custom: custom.assetHubKusama,
  initStorages: getInitStorages(custom.assetHubKusama),
})

export const assetHubWestend = defineChain({
  name: 'assetHubWestend',
  endpoint: 'wss://westend-asset-hub-rpc.polkadot.io',
  paraId: 1000,
  custom: custom.assetHubWestend,
  initStorages: getInitStorages(custom.assetHubWestend),
})
