import { defineChain } from '../defineChain.js'
import { defaultAccounts, defaultAccountsSr25519 } from '../testAccounts.js'

const custom = {
  integriteePolkadot: {
    xcmTeer: { Concrete: { parents: 0, interior: 'Here' } },
    xcmRelayNative: { Concrete: { parents: 1, interior: 'Here' } },
    assetIdRelayNative: 0,
  },
  integriteeKusama: {
    xcmTeer: { Concrete: { parents: 0, interior: 'Here' } },
    xcmRelayNative: { Concrete: { parents: 1, interior: 'Here' } },
    assetIdRelayNative: 0,
  },
}

const getInitStorages = (config: typeof custom.integriteePolkadot | typeof custom.integriteeKusama) => ({
  System: {
    account: [
      // legacy. not needed for own tests
      [[defaultAccounts.alice.address], { providers: 1, data: { free: 1000e12 } }],
      // this is what will be used (for easier debugging in PJS)
      [[defaultAccountsSr25519.alice.address], { providers: 1, data: { free: 1000e12 } }],
    ],
  },
  Assets: {
    account: [
      // legacy. not needed for own tests
      [[config.assetIdRelayNative, defaultAccounts.alice.address], { balance: 1000e12 }],
      // this is what will be used (for easier debugging in PJS)
      [[config.assetIdRelayNative, defaultAccountsSr25519.alice.address], { balance: 1000e12 }],
    ],
  },
  // this acceleration can cause mismatches. use with care!
  PolkadotXcm: {
    // avoid sending xcm version change notifications to makes things faster
    $removePrefix: ['versionNotifyTargets', 'versionNotifiers', 'supportedVersion'],
  },
})

export const integriteePolkadot = defineChain({
  name: 'integritee-polkadot',
  paraId: 2039,
  endpoint: 'wss://polkadot.api.integritee.network',
  custom: custom.integriteePolkadot,
  initStorages: getInitStorages(custom.integriteePolkadot),
})

export const integriteeKusama = defineChain({
  name: 'integritee-kusama',
  paraId: 2015,
  endpoint: 'wss://kusama.api.integritee.network',
  custom: custom.integriteeKusama,
  initStorages: getInitStorages(custom.integriteeKusama),
})
