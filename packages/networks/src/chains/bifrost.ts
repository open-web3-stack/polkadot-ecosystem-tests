import { defineChain } from '../defineChain.js'
import { defaultAccounts, defaultAccountsSr25519, testAccounts } from '../testAccounts.js'

const custom = {
  bifrostPolkadot: {
    relayToken: 'DOT',
    bnc: { Native: 'BNC' },
  },
  bifrostKusama: {
    relayToken: 'KSM',
    bnc: { Token: 'BNC' },
  },
}

const getInitStorages = (_config: typeof custom.bifrostPolkadot | typeof custom.bifrostKusama) => ({
  System: {
    account: [
      [[defaultAccounts.alice.address], { providers: 1, data: { free: 666e12 } }],
      [[defaultAccountsSr25519.alice.address], { providers: 1, data: { free: 666e12 } }],
      [[testAccounts.alice.address], { providers: 1, data: { free: 666e12 } }],
    ],
  },
  PolkadotXcm: {
    // avoid sending xcm version change notifications to makes things faster
    $removePrefix: ['versionNotifyTargets', 'versionNotifiers'],
  },
})

export const bifrostPolkadot = defineChain({
  name: 'bifrostPolkadot',
  endpoint: 'wss://bifrost-polkadot.ibp.network',
  paraId: 2030,
  custom: custom.bifrostPolkadot,
  initStorages: getInitStorages(custom.bifrostPolkadot),
})

export const bifrostKusama = defineChain({
  name: 'bifrostKusama',
  endpoint: 'wss://us.bifrost-rpc.liebi.com/ws',
  paraId: 2001,
  custom: custom.bifrostKusama,
  initStorages: getInitStorages(custom.bifrostKusama),
})
