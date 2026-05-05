import { standardFeeExtractor } from '@e2e-test/shared'

import { defineChain } from '../defineChain.js'
import endpoints from '../pet-chain-endpoints.json' with { type: 'json' }
import { defaultAccounts, defaultAccountsSr25519, testAccounts } from '../testAccounts.js'

const assetLocation = (assetId: number) => ({
  parents: 0,
  interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: assetId }] },
})

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
    usdtIndex: 1984, // Test-Tether (USDTT), 6 decimals — existing PSM external asset on WAH
    usdxIndex: 1338, // synthetic USDX (2 decimals) injected via Chopsticks override
    daiIndex: 1339, // synthetic DAI (18 decimals) injected via Chopsticks override
    psmStableAssetId: 50000342, // pUSD stable asset ID as deployed on WAH
    usdtLocation: assetLocation(1984),
    usdxLocation: assetLocation(1338),
    daiLocation: assetLocation(1339),
  },
}

const getAhwInitStorages = (config: typeof custom.assetHubWestend) => {
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
    Assets: {
      asset: [
        [
          [config.usdxIndex],
          {
            owner: testAccounts.alice.address,
            issuer: testAccounts.alice.address,
            admin: testAccounts.alice.address,
            freezer: testAccounts.alice.address,
            supply: 10000 * 100,
            deposit: 0,
            minBalance: 1,
            isSufficient: true,
            accounts: 2,
            sufficients: 2,
            approvals: 0,
            status: 'Live',
          },
        ],
        [
          [config.daiIndex],
          {
            owner: testAccounts.alice.address,
            issuer: testAccounts.alice.address,
            admin: testAccounts.alice.address,
            freezer: testAccounts.alice.address,
            supply: 10000n * 10n ** 18n,
            deposit: 0,
            minBalance: 1,
            isSufficient: true,
            accounts: 2,
            sufficients: 2,
            approvals: 0,
            status: 'Live',
          },
        ],
      ],
      metadata: [
        [
          [config.usdxIndex],
          { deposit: 0, name: 'Low-Decimal Stablecoin', symbol: 'USDX', decimals: 2, isFrozen: false },
        ],
        [[config.daiIndex], { deposit: 0, name: 'Dai Stablecoin', symbol: 'DAI', decimals: 18, isFrozen: false }],
      ],
      account: [
        [[config.usdtIndex, testAccounts.alice.address], { balance: 1000e6 }],
        [[config.usdtIndex, testAccounts.bob.address], { balance: 1000e6 }],
        [[config.usdxIndex, testAccounts.alice.address], { balance: 1000 * 100 }],
        [[config.usdxIndex, testAccounts.bob.address], { balance: 1000 * 100 }],
        [[config.daiIndex, testAccounts.alice.address], { balance: 1000n * 10n ** 18n }],
        [[config.daiIndex, testAccounts.bob.address], { balance: 1000n * 10n ** 18n }],
        [[config.psmStableAssetId, testAccounts.alice.address], { balance: 1000e6 }],
      ],
    },
    Psm: {
      maxPsmDebtOfTotal: 500_000,
      externalAssets: [
        [[config.usdtLocation], { AllEnabled: null }],
        [[config.usdxLocation], { AllEnabled: null }],
        [[config.daiLocation], { AllEnabled: null }],
      ],
      externalDecimals: [
        [[config.usdtLocation], 6],
        [[config.usdxLocation], 2],
        [[config.daiLocation], 18],
      ],
      mintingFee: [
        [[config.usdtLocation], 5_000],
        [[config.usdxLocation], 5_000],
        [[config.daiLocation], 5_000],
      ],
      redemptionFee: [
        [[config.usdtLocation], 5_000],
        [[config.usdxLocation], 5_000],
        [[config.daiLocation], 5_000],
      ],
      assetCeilingWeight: [
        [[config.usdtLocation], 400_000],
        [[config.usdxLocation], 300_000],
        [[config.daiLocation], 300_000],
      ],
      psmDebt: [
        [[config.usdtLocation], 0],
        [[config.usdxLocation], 0],
        [[config.daiLocation], 0],
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
  initStorages: getAhwInitStorages(custom.assetHubWestend),
  properties: ahwProperties,
})
