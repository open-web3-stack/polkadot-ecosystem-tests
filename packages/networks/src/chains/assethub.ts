import { standardFeeExtractor } from '@e2e-test/shared'

import { defineChain } from '../defineChain.js'
import endpoints from '../pet-chain-endpoints.json' with { type: 'json' }
import { defaultAccounts, defaultAccountsSr25519, testAccounts } from '../testAccounts.js'

const custom = {
  assetHubPolkadot: {
    dot: { Concrete: { parents: 1, interior: 'Here' } },
    usdt: { Concrete: { parents: 0, interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: 1984 }] } } },
    usdtIndex: 1984,
    usdcIndex: 1337,
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
  assetHubWestend: {
    wnd: { Concrete: { parents: 1, interior: 'Here' } },
  },
}

const getAhwInitStorages = () => {
  return {
    System: {
      account: [
        [[defaultAccounts.alice.address], { providers: 1, data: { free: 1000e10 } }],
        [[defaultAccountsSr25519.alice.address], { providers: 1, data: { free: 1000e10 } }],
        [[testAccounts.alice.address], { providers: 1, data: { free: 100_000e10 } }],
        [[testAccounts.bob.address], { providers: 1, data: { free: 100_000e10 } }],
        [[testAccounts.charlie.address], { providers: 1, data: { free: 100_000e10 } }],
        [[testAccounts.dave.address], { providers: 1, data: { free: 100_000e10 } }],
        [[testAccounts.eve.address], { providers: 1, data: { free: 100_000e10 } }],
        [[testAccounts.ferdie.address], { providers: 1, data: { free: 100_000e10 } }],
      ],
    },
  }
}

const getInitStorages = (config: typeof custom.assetHubPolkadot | typeof custom.assetHubKusama) => {
  const baseStorages = {
    System: {
      account: [
        [[defaultAccounts.alice.address], { providers: 1, data: { free: 1000e10 } }],
        [[defaultAccountsSr25519.alice.address], { providers: 1, data: { free: 1000e10 } }],
        [[testAccounts.alice.address], { providers: 1, data: { free: 1000e10 } }],
      ],
    },
    Assets: {
      account: [[[config.usdtIndex, defaultAccounts.alice.address], { balance: 1000e6 }]],
    },
    ForeignAssets: {
      account: [
        [[config.eth, defaultAccounts.alice.address], { balance: 10n ** 18n }],
        [[config.eth, '13cKp89Msu7M2PiaCuuGr1BzAsD5V3vaVbDMs3YtjMZHdGwR'], { balance: 10n ** 20n }],
      ],
    },
  }

  return baseStorages
}

export const assetHubPolkadot = defineChain({
  name: 'assetHubPolkadot',
  endpoint: endpoints.assetHubPolkadot,
  paraId: 1000,
  networkGroup: 'polkadot',
  custom: custom.assetHubPolkadot,
  initStorages: getInitStorages(custom.assetHubPolkadot),
  properties: {
    addressEncoding: 0,
    proxyBlockProvider: 'NonLocal',
    schedulerBlockProvider: 'NonLocal',
    asyncBacking: 'Enabled',
    feeExtractor: standardFeeExtractor,
  },
})

export const assetHubKusama = defineChain({
  name: 'assetHubKusama',
  endpoint: endpoints.assetHubKusama,
  paraId: 1000,
  networkGroup: 'kusama',
  custom: custom.assetHubKusama,
  initStorages: getInitStorages(custom.assetHubKusama),
  properties: {
    addressEncoding: 2,
    proxyBlockProvider: 'NonLocal',
    schedulerBlockProvider: 'NonLocal',
    asyncBacking: 'Enabled',
    feeExtractor: standardFeeExtractor,
  },
})

const ahwProperties = {
  addressEncoding: 42,
  proxyBlockProvider: 'NonLocal',
  schedulerBlockProvider: 'NonLocal',
  asyncBacking: 'Enabled',
  feeExtractor: standardFeeExtractor,
} as const

export const assetHubWestend = defineChain({
  name: 'assetHubWestend',
  endpoint: endpoints.assetHubWestend,
  paraId: 1000,
  networkGroup: 'westend',
  custom: custom.assetHubWestend,
  initStorages: getAhwInitStorages(),
  properties: ahwProperties,
})
