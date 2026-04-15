import { standardFeeExtractor } from '@e2e-test/shared'

import { defineChain } from '../defineChain.js'
import endpoints from '../pet-chain-endpoints.json' with { type: 'json' }
import { defaultAccounts, defaultAccountsSr25519, testAccounts } from '../testAccounts.js'

const PSM_INSURANCE_FUND_RAW = '0x6d6f646c70792f706567736d0000000000000000000000000000000000000000'

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
    // PSM (Peg Stability Module) configuration
    psmStableAssetId: 4242, // pUSD asset ID (matches kitchensink config)
    psmUsdcId: 1337, // USDC asset ID on PAH
    psmUsdtId: 1984, // USDT asset ID on PAH (already used for XCM tests)
    psmInsuranceFundAccountRaw: PSM_INSURANCE_FUND_RAW,
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

  // PSM-specific storage entries for Polkadot
  if ('psmStableAssetId' in config) {
    ;(baseStorages.System.account as any).push(
      [[testAccounts.bob.address], { providers: 1, data: { free: 1000e10 } }], // DOT for Bob's tx fees
    )
    if (!baseStorages.Assets.asset) (baseStorages.Assets as any).asset = []
    ;(baseStorages.Assets.asset as any).push([
      [config.psmStableAssetId],
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
      [[config.psmUsdcId, testAccounts.alice.address], { balance: 1000e6 }], // USDC for Alice
      [[config.psmUsdcId, testAccounts.bob.address], { balance: 1000e6 }], // USDC for Bob
      [[config.psmStableAssetId, testAccounts.alice.address], { balance: 1000e6 }], // pUSD for Alice
    )
    ;(baseStorages as any).Psm = {
      maxPsmDebtOfTotal: 500_000, // Permill: 50% of MaxIssuance
      externalAssets: [
        [[1337], { AllEnabled: null }], // USDC -> AllEnabled
        [[1984], { AllEnabled: null }], // USDT -> AllEnabled
      ],
      mintingFee: [
        [[1337], 5_000], // Permill: 0.5% for USDC
        [[1984], 5_000], // Permill: 0.5% for USDT
      ],
      redemptionFee: [
        [[1337], 5_000], // Permill: 0.5%
        [[1984], 5_000], // Permill: 0.5%
      ],
      assetCeilingWeight: [
        [[1337], 600_000], // Permill: 60% weight for USDC
        [[1984], 400_000], // Permill: 40% weight for USDT
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
