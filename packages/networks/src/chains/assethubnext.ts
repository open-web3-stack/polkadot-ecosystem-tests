import { defaultAccounts, defaultAccountsSr25519 } from '../defaultAccounts.js'
import { defineChain } from '../defineChain.js'

const custom = {
  assetHubNextWestend: {
    wnd: { Concrete: { parents: 1, interior: 'Here' } },
    usdt: { Concrete: { parents: 0, interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: 1984 }] } } },
    usdtIndex: 1984,
  },
}

const getInitStorages = (config: typeof custom.assetHubNextWestend) => ({
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

export const assetHubNextWestend = defineChain({
  name: 'assetHubNextWestend',
  endpoint: 'wss://westend-asset-hub-next-rpc.parity-chains-scw.parity.io',
  paraId: 1100,
  custom: custom.assetHubNextWestend,
  initStorages: getInitStorages(custom.assetHubNextWestend),
})
