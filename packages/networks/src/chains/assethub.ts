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

  if ('usdcIndex' in config) {
    const PSM_STABLE_ASSET_ID = 4242
    ;(baseStorages.System.account as any).push([[testAccounts.bob.address], { providers: 1, data: { free: 1000e10 } }])
    if (!(baseStorages.Assets as any).asset) (baseStorages.Assets as any).asset = []
    ;((baseStorages.Assets as any).asset as any).push([
      [PSM_STABLE_ASSET_ID],
      {
        owner: testAccounts.alice.address,
        issuer: testAccounts.alice.address,
        admin: testAccounts.alice.address,
        freezer: testAccounts.alice.address,
        supply: 1000e6,
        deposit: 0,
        minBalance: 1,
        isSufficient: true,
        accounts: 1,
        sufficients: 1,
        approvals: 0,
        status: 'Live',
      },
    ])
    ;(baseStorages.Assets.account as any).push(
      [[config.usdcIndex, testAccounts.alice.address], { balance: 1000e6 }],
      [[config.usdcIndex, testAccounts.bob.address], { balance: 1000e6 }],
      [[PSM_STABLE_ASSET_ID, testAccounts.alice.address], { balance: 1000e6 }],
    )
    ;(baseStorages as any).Psm = {
      maxPsmDebtOfTotal: 500_000, // Permill: 50% of MaxIssuance
      externalAssets: [
        [[config.usdcIndex], { AllEnabled: null }], // USDC -> AllEnabled
        [[config.usdtIndex], { AllEnabled: null }], // USDT -> AllEnabled
      ],
      mintingFee: [
        [[config.usdcIndex], 5_000], // Permill: 0.5% for USDC
        [[config.usdtIndex], 5_000], // Permill: 0.5% for USDT
      ],
      redemptionFee: [
        [[config.usdcIndex], 5_000], // Permill: 0.5% for USDC
        [[config.usdtIndex], 5_000], // Permill: 0.5% for USDT
      ],
      assetCeilingWeight: [
        [[config.usdcIndex], 600_000], // Permill: 60% weight for USDC
        [[config.usdtIndex], 400_000], // Permill: 40% weight for USDT
      ],
    }
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
