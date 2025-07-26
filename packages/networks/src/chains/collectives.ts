import { defaultAccounts, defaultAccountsSr25519 } from '../defaultAccounts.js'
import { defineChain } from '../defineChain.js'

const custom = {
  collectivesPolkadot: {
    dot: { Concrete: { parents: 1, interior: 'Here' } },
  },
}

const getInitStorages = (_config: typeof custom.collectivesPolkadot) => ({
  System: {
    account: [
      [[defaultAccountsSr25519.alice.address], { providers: 1, data: { free: 1000e10 } }],
      [[defaultAccounts.alice.address], { providers: 1, data: { free: 1000e10 } }],
      [[defaultAccounts.bob.address], { providers: 1, data: { free: 1000e10 } }],
    ],
  },
})

export const collectivesPolkadot = defineChain({
  name: 'collectivesPolkadot',
  endpoint: 'wss://collectives-polkadot-rpc.n.dwellir.com',
  paraId: 1001,
  custom: custom.collectivesPolkadot,
  initStorages: getInitStorages(custom.collectivesPolkadot),
})
