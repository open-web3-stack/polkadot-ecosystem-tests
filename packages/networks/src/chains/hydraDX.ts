import { defaultAccount } from '@e2e-test/shared'

import { defineChain } from '../defineChain.js'

const custom = {
  hydraDX: {
    dai: 2,
    relayToken: 5,
  },
  basilisk: {
    dai: 13,
    relayToken: 1,
  },
}

const getInitStorages = (config: typeof custom.hydraDX | typeof custom.basilisk) => ({
  System: {
    Account: [[[defaultAccount.alice.address], { providers: 1, data: { free: 1000 * 1e12 } }]],
  },
  Tokens: {
    Accounts: [
      [[defaultAccount.alice.address, config.relayToken], { free: 1000 * 1e12 }],
      [[defaultAccount.alice.address, config.dai], { free: 100n * 10n ** 18n }],
    ],
  },
})

export const hydraDX = defineChain({
  name: 'hydraDX',
  paraId: 2034,
  endpoint: 'https://rpc.hydradx.cloud',
  custom: custom.hydraDX,
  initStorages: getInitStorages(custom.hydraDX),
})

export const basilisk = defineChain({
  name: 'basilisk',
  paraId: 2090,
  endpoint: 'https://basilisk-rpc.dwellir.com',
  custom: custom.basilisk,
  initStorages: getInitStorages(custom.basilisk),
})
