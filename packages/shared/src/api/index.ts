import type { ApiPromise } from '@polkadot/api'

export type TransferType = 'Teleport' | 'LocalReserve' | 'DestinationReserve' | 'RemoteReserve'

export const xtokens = {
  relaychainV3: (acc: any) => ({
    V3: {
      parents: 1,
      interior: {
        X1: {
          AccountId32: {
            id: acc,
          },
        },
      },
    },
  }),
  relaychainV4: (acc: any) => ({
    V4: {
      parents: 1,
      interior: {
        X1: {
          AccountId32: {
            id: acc,
          },
        },
      },
    },
  }),
  parachainAccountId20V3: (paraId: number) => (acc: any) => ({
    V3: {
      parents: 1,
      interior: {
        X2: [
          { Parachain: paraId },
          {
            AccountKey20: {
              key: acc,
            },
          },
        ],
      },
    },
  }),
  parachainV3: (paraId: number) => (acc: any) => ({
    V3: {
      parents: 1,
      interior: {
        X2: [
          { Parachain: paraId },
          {
            AccountId32: {
              id: acc,
            },
          },
        ],
      },
    },
  }),
  parachainV4: (paraId: number) => (acc: any) => ({
    V4: {
      parents: 1,
      interior: {
        X2: [
          { Parachain: paraId },
          {
            AccountId32: {
              id: acc,
            },
          },
        ],
      },
    },
  }),
  transfer:
    (token: any, amount: any, dest: (dest: any) => any, weight: any = 'Unlimited') =>
    ({ api }: { api: ApiPromise }, acc: any) =>
      api.tx.xTokens.transfer(token, amount, dest(acc), weight),
  transferMulticurrencies:
    (token: any, amount: any, feeToken: any, feeAmount: any, dest: (dest: any) => any) =>
    ({ api }: { api: ApiPromise }, acc: any) =>
      api.tx.xTokens.transferMulticurrencies(
        [
          [token, amount],
          [feeToken, feeAmount],
        ],
        1,
        dest(acc),
        'Unlimited',
      ),
}

export const xcmPallet = {
  relaychainV4: {
    V4: {
      parents: 1,
      interior: 'Here',
    },
  },
  parachainV3: (parents: number, paraId: any) => ({
    V3: {
      parents,
      interior: {
        X1: { Parachain: paraId },
      },
    },
  }),
  parachainV4: (parents: number, paraId: any) => ({
    V4: {
      parents,
      interior: {
        X1: [{ Parachain: paraId }],
      },
    },
  }),
  limitedTeleportAssets:
    (token: any, amount: any, dest: any) =>
    ({ api }: { api: ApiPromise }, acc: any) =>
      (api.tx.xcmPallet || api.tx.polkadotXcm).limitedTeleportAssets(
        dest,
        {
          V3: {
            parents: 0,
            interior: {
              X1: {
                AccountId32: {
                  // network: 'Any',
                  id: acc,
                },
              },
            },
          },
        },
        {
          V3: [
            {
              id: token,
              fun: { Fungible: amount },
            },
          ],
        },
        0,
        'Unlimited',
      ),
  limitedReserveTransferAssetsV3:
    (token: any, amount: any, dest: any) =>
    ({ api }: { api: ApiPromise }, acc: any) =>
      (api.tx.xcmPallet || api.tx.polkadotXcm).limitedReserveTransferAssets(
        dest,
        {
          V3: {
            parents: 0,
            interior: {
              X1: {
                AccountId32: {
                  id: acc,
                },
              },
            },
          },
        },
        {
          V3: [
            {
              id: token,
              fun: { Fungible: amount },
            },
          ],
        },
        0,
        'Unlimited',
      ),
  teleportAssetsV3:
    (token: any, amount: any, dest: any) =>
    ({ api }: { api: ApiPromise }, acc: any) =>
      (api.tx.xcmPallet || api.tx.polkadotXcm).teleportAssets(
        dest,
        {
          V3: {
            parents: 0,
            interior: {
              X1: {
                AccountId32: {
                  id: acc,
                },
              },
            },
          },
        },
        {
          V3: [
            {
              id: token,
              fun: { Fungible: amount },
            },
          ],
        },
        0,
      ),
  executeXCM:
    (xcm: any, max_weight: any) =>
    ({ api }: { api: ApiPromise }) => {
      return (api.tx.xcmPallet || api.tx.polkadotXcm).execute(xcm, max_weight)
    },
  transferAssetsV3:
    (token: any, amount: any, dest: any) =>
    ({ api }: { api: ApiPromise }, acc: any) =>
      (api.tx.xcmPallet || api.tx.polkadotXcm).transferAssets(
        dest,
        {
          V3: {
            parents: 0,
            interior: {
              X1: {
                AccountId32: {
                  id: acc,
                },
              },
            },
          },
        },
        {
          V3: [
            {
              id: token,
              fun: { Fungible: amount },
            },
          ],
        },
        0,
        'Unlimited',
      ),
  transferAssetsUsingType:
    (dest: any, tokens: any[], assetTransferType: TransferType, remoteFeesId: any, feesTransferType: TransferType) =>
    ({ api }: { api: ApiPromise }, acc: any) =>
      (api.tx.xcmPallet || api.tx.polkadotXcm).transferAssetsUsingTypeAndThen(
        dest,
        { V4: tokens },
        assetTransferType,
        { V4: remoteFeesId },
        feesTransferType,
        {
          V4: [
            {
              DepositAsset: {
                assets: {
                  Wild: {
                    AllCounted: 2,
                  },
                },
                beneficiary: {
                  parents: 0,
                  interior: { X1: [{ AccountId32: { id: acc } }] },
                },
              },
            },
          ],
        },
        'Unlimited',
      ),
}

export const tx = {
  xtokens,
  xcmPallet,
}

export const query = {
  balances: ({ api }: { api: ApiPromise }, address: string) => api.query.system.account(address),
  totalIssuance: ({ api }: { api: ApiPromise }) => api.query.balances.totalIssuance(),
  tokens:
    (token: any) =>
    ({ api }: { api: ApiPromise }, address: string) =>
      api.query.tokens.accounts(address, token),
  assets:
    (token: number | bigint) =>
    ({ api }: { api: ApiPromise }, address: string) =>
      api.query.assets.account(token, address),
  foreignAssets:
    (token: any) =>
    ({ api }: { api: ApiPromise }, address: string) =>
      api.query.foreignAssets.account(token, address),
  evm:
    (contract: string, slot: string) =>
    ({ api }: { api: ApiPromise }, _address: string) =>
      api.query.evm.accountStorages(contract, slot),
}
