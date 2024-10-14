import { defaultAccounts } from '../defaultAccounts.js'
import { defineChain } from '../defineChain.js'

const custom = {
  peoplePolkadot: {
    dot: { Concrete: { parents: 1, interior: 'Here' } },
  },
  peopleKusama: {
    ksm: { Concrete: { parents: 1, interior: 'Here' } },
  },
}

const getInitStorages = (_config: typeof custom.peoplePolkadot | typeof custom.peopleKusama) => ({
  System: {
    account: [
      [[defaultAccounts.alice.address], { providers: 1, data: { free: 1000e10 } }],
      [[defaultAccounts.bob.address], { providers: 1, data: { free: 1000e10 } }],
    ],
  },
  // Registrars to be used in E2E tests - required to test `RegistrarOrigin`-locked extrinsics.
  Identity: {
    Registrars: [
      {
        account: defaultAccounts.alice.address,
        fee: 0,
        fields: 0,
      },
      {
        account: defaultAccounts.bob.address,
        fee: 0,
        fields: 0,
      },
    ],
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
  endpoint: 'wss://kusama-people-rpc.polkadot.io',
  paraId: 1004,
  custom: custom.peopleKusama,
  initStorages: getInitStorages(custom.peopleKusama),
})
