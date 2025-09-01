import { defineChain } from '../defineChain.js'
import { defaultAccounts, defaultAccountsSr25519, testAccounts } from '../testAccounts.js'

const custom = {
  assetHubPolkadot: {
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
}

const getInitStorages = (config: typeof custom.assetHubPolkadot | typeof custom.assetHubKusama) => ({
  System: {
    account: [
      [[defaultAccounts.alice.address], { providers: 1, data: { free: 1000e10 } }],
      [[defaultAccountsSr25519.alice.address], { providers: 1, data: { free: 1000e10 } }],
      [[testAccounts.alice.address], { providers: 1, data: { free: 1000e10 } }],
    ],
  },
  Assets: {
    account: [
      [[config.usdtIndex, defaultAccounts.alice.address], { balance: 1000e6 }], // USDT
    ],
  },
  ForeignAssets: {
    account: [
      [[config.eth, defaultAccounts.alice.address], { balance: 10n ** 18n }], // 1 ETH
      [[config.eth, '13cKp89Msu7M2PiaCuuGr1BzAsD5V3vaVbDMs3YtjMZHdGwR'], { balance: 10n ** 20n }], // 100 ETH for Sibling 2000
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
