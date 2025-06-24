import { defaultAccounts, defaultAccountsSr25519 } from '../defaultAccounts.js'
import { defineChain } from '../defineChain.js'

const custom = {
  peoplePolkadot: {
    units: 1e10,
    dot: { Concrete: { parents: 1, interior: 'Here' } },
  },
  peopleKusama: {
    units: 1e10,
    ksm: { Concrete: { parents: 1, interior: 'Here' } },
  },
  peopleWestend: {
    units: 1e12,
    wnd: { Concrete: { parents: 1, interior: 'Here' } },
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

const getInitStorages = (
  config: typeof custom.peoplePolkadot | typeof custom.peopleKusama | typeof custom.peopleWestend,
) => {
  const baseAmount = 1000
  const amount = BigInt(baseAmount) * BigInt(config.units)

  return {
    System: {
      account: [
        [[defaultAccounts.alice.address], { providers: 1, data: { free: amount } }],
        [[defaultAccounts.bob.address], { providers: 1, data: { free: amount } }],
        [[defaultAccountsSr25519.alice.address], { providers: 1, data: { free: amount } }],
        [[defaultAccountsSr25519.bob.address], { providers: 1, data: { free: amount } }],
      ],
    },
    // Registrars to be used in E2E tests - required to test `RegistrarOrigin`-locked extrinsics.
    Identity: {
      Registrars: [aliceRegistrar, bobRegistrar],
    },
  }
}

export const peoplePolkadot = defineChain({
  name: 'peoplePolkadot',
  endpoint: 'wss://polkadot-people-rpc.polkadot.io',
  paraId: 1004,
  custom: custom.peoplePolkadot,
  initStorages: getInitStorages(custom.peoplePolkadot),
})

export const peopleKusama = defineChain({
  name: 'peopleKusama',
  endpoint: 'wss://kusama-people-rpc.polkadot.io',
  paraId: 1004,
  custom: custom.peopleKusama,
  initStorages: getInitStorages(custom.peopleKusama),
})

export const peopleWestend = defineChain({
  name: 'peopleWestend',
  endpoint: 'wss://westend-people-rpc.polkadot.io',
  paraId: 1004,
  custom: custom.peopleWestend,
  initStorages: getInitStorages(custom.peopleWestend),
})
