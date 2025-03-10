import { defaultAccounts, defaultAccountsSr25519 } from '../defaultAccounts.js'
import { defineChain } from '../defineChain.js'

const custom = {
  assetHubNext: {
    dot: { Concrete: { parents: 1, interior: 'Here' } },
    usdt: { Concrete: { parents: 0, interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: 1984 }] } } },
    usdtIndex: 1984,
  },
}

const getInitStorages = (config: typeof custom.assetHubNext) => ({
  System: {
    account: [
      [[defaultAccounts.alice.address], { providers: 1, data: { free: 1000e10 } }],
      [[defaultAccountsSr25519.alice.address], { providers: 1, data: { free: 1000e10 } }],
    ],
  },
  Assets: {
    account: [
      [[config.usdtIndex, defaultAccounts.alice.address], { balance: 1000e6 }], // USDT
    ],
  },
})

export const assetHubNext = defineChain({
  name: 'assetHubNext',
  endpoint: 'wss://westend-asset-hub-next-rpc.parity-chains-scw.parity.io',
  paraId: 1100,
  custom: custom.assetHubNext,
  initStorages: getInitStorages(custom.assetHubNext),
})
