import { defaultAccounts, defaultAccountsSr25519 } from '../defaultAccounts.js'
import { defineChain } from '../defineChain.js'

const custom = {
  peoplePolkadot: {
    dot: { Concrete: { parents: 1, interior: 'Here' } },
  },
  peopleKusama: {
    ksm: { Concrete: { parents: 1, interior: 'Here' } },
  },
}

const aliceRegistrar = {
  account: defaultAccountsSr25519.alice.address,
  fee: 1,
  fields: 0,
}

const bobRegistrar = {
  account: defaultAccountsSr25519.bob.address,
  fee: 0,
  fields: 0,
}

const getInitStorages = (_config: typeof custom.peoplePolkadot | typeof custom.peopleKusama) => ({
  System: {
    account: [
      [[defaultAccounts.alice.address], { providers: 1, data: { free: 1000e10 } }],
      [[defaultAccounts.bob.address], { providers: 1, data: { free: 1000e10 } }],
      [[defaultAccountsSr25519.alice.address], { providers: 1, data: { free: 1000e10 } }],
      [[defaultAccountsSr25519.bob.address], { providers: 1, data: { free: 1000e10 } }],
    ],
  },
  // Registrars to be used in E2E tests - required to test `RegistrarOrigin`-locked extrinsics.
  Identity: {
    Registrars: [aliceRegistrar, bobRegistrar],
  },
})

export const peoplePolkadot = defineChain({
  name: 'peoplePolkadot',
  endpoint: 'wss://polkadot-people-rpc.polkadot.io',
  paraId: 1004,
  custom: custom.peoplePolkadot,
  initStorages: getInitStorages(custom.peoplePolkadot),
})

export const peopleKusama = defineChain({
  name: 'peopleKusama',
  endpoint: 'wss://people-kusama.dotters.network',
  paraId: 1004,
  custom: custom.peopleKusama,
  initStorages: getInitStorages(custom.peopleKusama),
})
