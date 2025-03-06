import { defaultAccounts } from '../defaultAccounts.js'
import { defineChain } from '../defineChain.js'

const custom = {
  assetHubPolkadot: {
    dot: { Concrete: { parents: 1, interior: 'Here' } },
    usdt: { Concrete: { parents: 0, interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: 1984 }] } } },
    weth: {
      Concrete: {
        parents: 2,
        interior: {
          X2: [{ GlobalConsenus: 1 }, { AccountKey20: { key: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' } }],
        },
      },
    },
    usdtIndex: 1984,
  },
  assetHubKusama: {
    ksm: { Concrete: { parents: 1, interior: 'Here' } },
    usdt: { Concrete: { parents: 0, interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: 1984 }] } } },
    weth: {
      Concrete: {
        parents: 2,
        interior: {
          X2: [{ GlobalConsenus: 1 }, { AccountKey20: { key: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' } }],
        },
      },
    },
    usdtIndex: 1984,
  },
}

const getInitStorages = (config: typeof custom.assetHubPolkadot | typeof custom.assetHubKusama) => ({
  System: {
    account: [[[defaultAccounts.alice.address], { providers: 1, data: { free: 1000e10 } }]],
  },
  Assets: {
    account: [
      [[config.usdtIndex, defaultAccounts.alice.address], { balance: 1000e6 }], // USDT
    ],
  },
  ForeignAssets: {
    account: [
      [[config.weth, defaultAccounts.alice.address], { balance: 1000e18 }], // WETH
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
