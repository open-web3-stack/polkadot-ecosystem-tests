import { defaultAccount } from '@e2e-test/shared'

import { defineChain } from '../defineChain.js'

const custom = {
  assetHubPolkadot: {
    dot: { Concrete: { parents: 1, interior: 'Here' } },
    wbtc: { Concrete: { parents: 0, interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: 21 }] } } },
    wbtcIndex: 21,
    usdtIndex: 1984,
  },
  assetHubKusama: {
    ksm: { Concrete: { parents: 1, interior: 'Here' } },
    usdt: { Concrete: { parents: 0, interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: 1984 }] } } },
    usdtIndex: 1984,
  },
}

const getInitStorages = (config: typeof custom.assetHubPolkadot | typeof custom.assetHubKusama) => ({
  System: {
    account: [[[defaultAccount.alice.address], { providers: 1, data: { free: 1000e10 } }]],
  },
  Assets: {
    account: [
      [[config.usdtIndex, defaultAccount.alice.address], { balance: 1000e6 }], // USDT
    ],
  },
})

export const assetHubPolkadot = defineChain({
  name: 'assetHubPolkadot',
  endpoint: 'https://statemint-rpc-tn.dwellir.com',
  paraId: 1000,
  custom: custom.assetHubPolkadot,
  initStorages: getInitStorages(custom.assetHubPolkadot),
})

export const assetHubKusama = defineChain({
  name: 'assetHubKusama',
  endpoint: 'https://statemine-rpc-tn.dwellir.com',
  paraId: 1000,
  custom: custom.assetHubKusama,
  initStorages: getInitStorages(custom.assetHubKusama),
})
