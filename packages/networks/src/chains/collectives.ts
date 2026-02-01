import { defineChain } from '../defineChain.js'
import { defaultAccounts, defaultAccountsSr25519, testAccounts } from '../testAccounts.js'

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
      [[testAccounts.alice.address], { providers: 1, data: { free: 1000e10 } }],
    ],
  },
})

export const collectivesPolkadot = defineChain({
  name: 'collectivesPolkadot',
  endpoint: ['wss://sys.ibp.network/collectives-polkadot', 'wss://collectives-polkadot-rpc.n.dwellir.com'],
  paraId: 1001,
  networkGroup: 'polkadot',
  custom: custom.collectivesPolkadot,
  initStorages: getInitStorages(custom.collectivesPolkadot),
})
