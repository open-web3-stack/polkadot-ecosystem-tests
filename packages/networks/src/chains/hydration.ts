import { standardFeeExtractor } from '@e2e-test/shared'

import { defineChain } from '../defineChain.js'
import { defaultAccounts, defaultAccountsSr25519 } from '../testAccounts.js'

const custom = {
  hydration: {
    dai: 2,
    relayToken: 5,
    glmr: 16,
  },
  basilisk: {
    bsx: 0,
    dai: 13,
    relayToken: 1,
  },
}

const getInitStorages = (config: typeof custom.hydration | typeof custom.basilisk) => ({
  System: {
    Account: [[[defaultAccountsSr25519.alice.address], { providers: 1, data: { free: 10n ** 18n } }]],
  },
  Tokens: {
    Accounts: [
      [[defaultAccountsSr25519.alice.address, config.relayToken], { free: 1000 * 1e12 }],
      [[defaultAccounts.alice.address, config.dai], { free: 100n * 10n ** 18n }],
    ],
  },
})

export const hydration = defineChain({
  name: 'hydration',
  paraId: 2034,
  endpoint: ['wss://hydration.ibp.network', 'wss://rpc.hydradx.cloud'],
  networkGroup: 'polkadot',
  custom: custom.hydration,
  initStorages: getInitStorages(custom.hydration),
  properties: {
    addressEncoding: 0,
    schedulerBlockProvider: 'Local',
    asyncBacking: 'Enabled',
    feeExtractor: standardFeeExtractor,
  },
})

export const basilisk = defineChain({
  name: 'basilisk',
  paraId: 2090,
  endpoint: ['wss://basilisk-rpc.n.dwellir.com', 'wss://rpc.basilisk.cloud'],
  networkGroup: 'kusama',
  custom: custom.basilisk,
  initStorages: getInitStorages(custom.basilisk),
  properties: {
    addressEncoding: 10041,
    schedulerBlockProvider: 'Local',
    asyncBacking: 'Enabled',
    feeExtractor: standardFeeExtractor,
  },
})
