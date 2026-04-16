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
    usdtIndex: 1984, // Test-Tether (USDTT), 6 decimals — existing PSM external asset on WAH
    usdcIndex: 1337, // synthetic USDC injected via Chopsticks override
    psmStableAssetId: 50000342, // pUSD stable asset ID as deployed on WAH
  },
}

const getPsmInitStorages = (config: typeof custom.assetHubWestend) => {
  return {
    System: {
      account: [
        [[defaultAccounts.alice.address], { providers: 1, data: { free: 1000e10 } }],
        [[defaultAccountsSr25519.alice.address], { providers: 1, data: { free: 1000e10 } }],
        [[testAccounts.alice.address], { providers: 1, data: { free: 1000e10 } }],
        [[testAccounts.bob.address], { providers: 1, data: { free: 1000e10 } }],
      ],
    },
    Assets: {
      // USDC (1337) is synthetic — does not exist on WAH. Full entry required.
      // pUSD (50000342) and USDT (1984) already exist on WAH; only account balances needed.
      asset: [
        [
          [config.usdcIndex],
          {
            owner: testAccounts.alice.address,
            issuer: testAccounts.alice.address,
            admin: testAccounts.alice.address,
            freezer: testAccounts.alice.address,
            supply: 10000e6,
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
      metadata: [[[config.usdcIndex], { deposit: 0, name: 'USD Coin', symbol: 'USDC', decimals: 6, isFrozen: false }]],
      account: [
        [[config.usdtIndex, testAccounts.alice.address], { balance: 1000e6 }], // USDT for Alice
        [[config.usdtIndex, testAccounts.bob.address], { balance: 1000e6 }], // USDT for Bob
        [[config.usdcIndex, testAccounts.alice.address], { balance: 1000e6 }], // USDC for Alice
        [[config.usdcIndex, testAccounts.bob.address], { balance: 1000e6 }], // USDC for Bob
        [[config.psmStableAssetId, testAccounts.alice.address], { balance: 1000e6 }], // pUSD for Alice
      ],
    },
    Psm: {
      // WAH has maxPsmDebtOfTotal at 10%; tests require a higher ceiling.
      maxPsmDebtOfTotal: 500_000, // Permill: 50% of MaxIssuance
      // USDC is not registered on WAH; inject alongside the existing USDT entry.
      externalAssets: [
        [[config.usdcIndex], { AllEnabled: null }], // USDC -> AllEnabled (synthetic)
        [[config.usdtIndex], { AllEnabled: null }], // USDT -> AllEnabled (live on WAH)
      ],
      mintingFee: [
        [[config.usdcIndex], 5_000], // Permill: 0.5% for USDC
        // WAH USDT mintingFee is 0%; override to match test expectations.
        [[config.usdtIndex], 5_000], // Permill: 0.5% for USDT
      ],
      redemptionFee: [
        [[config.usdcIndex], 5_000], // Permill: 0.5% for USDC
        // WAH USDT redemptionFee is 0.01%; override to match test expectations.
        [[config.usdtIndex], 5_000], // Permill: 0.5% for USDT
      ],
      assetCeilingWeight: [
        [[config.usdcIndex], 600_000], // Permill: 60% weight for USDC
        // WAH USDT ceiling is 100% (single asset); override for two-asset split.
        [[config.usdtIndex], 400_000], // Permill: 40% weight for USDT
      ],
      // WAH has live USDT debt (~90 UNIT); zero it so tests start from a clean state.
      psmDebt: [[[config.usdtIndex], 0]],
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

export const assetHubWestend = defineChain({
  name: 'assetHubWestend',
  endpoint: endpoints.assetHubWestend,
  paraId: 1000,
  networkGroup: 'westend',
  custom: custom.assetHubWestend,
  initStorages: getPsmInitStorages(custom.assetHubWestend),
  properties: {
    addressEncoding: 42,
    proxyBlockProvider: 'NonLocal',
    schedulerBlockProvider: 'NonLocal',
    asyncBacking: 'Enabled',
    feeExtractor: standardFeeExtractor,
  },
})
