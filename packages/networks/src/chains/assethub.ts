import { defaultAccounts, defaultAccountsSr25519 } from '../defaultAccounts.js'
import { defineChain } from '../defineChain.js'

const custom = {
  assetHubPolkadot: {
    units: 1e10,
    dot: { Concrete: { parents: 1, interior: 'Here' } },
    usdt: { Concrete: { parents: 0, interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: 1984 }] } } },
    usdtIndex: 1984,
    eth: {
      parents: 2,
      interior: {
        X1: [
          {
            GlobalConsensus: {
              Ethereum: {
                chainId: 1,
              },
            },
          },
        ],
      },
    },
  },
  assetHubKusama: {
    units: 1e10,
    ksm: { Concrete: { parents: 1, interior: 'Here' } },
    usdt: { Concrete: { parents: 0, interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: 1984 }] } } },
    usdtIndex: 1984,
    eth: {
      parents: 2,
      interior: {
        X1: [
          {
            GlobalConsensus: {
              Ethereum: {
                chainId: 1,
              },
            },
          },
        ],
      },
    },
  },
  assetHubWestend: {
    units: 1e12,
    wnd: { Concrete: { parents: 1, interior: 'Here' } },
    usdt: { Concrete: { parents: 0, interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: 1984 }] } } },
    usdtIndex: 1984,
    eth: null,
  },
}

const accountList = [
  [[defaultAccounts.alice.address], { providers: 1, data: { free: 1000e10 } }],
  [[defaultAccountsSr25519.alice.address], { providers: 1, data: { free: 1000e10 } }],
]

const getInitStorages = (
  config: typeof custom.assetHubPolkadot | typeof custom.assetHubKusama | typeof custom.assetHubWestend,
) => {
  const baseAmount = 1000
  const amount = BigInt(baseAmount) * BigInt(config.units)

  return {
    System: {
      account: [
        [[defaultAccounts.alice.address], { providers: 1, data: { free: amount } }],
        [[defaultAccountsSr25519.alice.address], { providers: 1, data: { free: amount } }],
      ],
    },
    Assets: {
      account: [
        [[config.usdtIndex, defaultAccounts.alice.address], { balance: 1000e6 }], // USDT
      ],
    },
    ForeignAssets: {
      account: config.eth ? accountList : [],
    },
  }
}

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
