import { defineChain } from '../defineChain.js'
import { defaultAccounts, defaultAccountsSr25519, testAccounts } from '../testAccounts.js'

const custom = {
  bridgeHubPolkadot: {
    dot: { Concrete: { parents: 1, interior: 'Here' } },
  },
  bridgeHubKusama: {
    ksm: { Concrete: { parents: 1, interior: 'Here' } },
  },
}

const getInitStorages = (_config: typeof custom.bridgeHubPolkadot | typeof custom.bridgeHubKusama) => ({
  System: {
    account: [
      [[defaultAccountsSr25519.alice.address], { providers: 1, data: { free: 1000e10 } }],
      [[defaultAccounts.alice.address], { providers: 1, data: { free: 1000e10 } }],
      [[testAccounts.alice.address], { providers: 1, data: { free: 1000e10 } }],
    ],
  },
})

export const bridgeHubPolkadot = defineChain({
  name: 'bridgeHubPolkadot',
  endpoint: 'wss://sys.ibp.network/bridgehub-polkadot',
  paraId: 1002,
  custom: custom.bridgeHubPolkadot,
  initStorages: getInitStorages(custom.bridgeHubPolkadot),
})

export const bridgeHubKusama = defineChain({
  name: 'bridgeHubKusama',
  endpoint: 'wss://kusama-bridge-hub-rpc.polkadot.io',
  paraId: 1002,
  custom: custom.bridgeHubKusama,
  initStorages: getInitStorages(custom.bridgeHubKusama),
})
