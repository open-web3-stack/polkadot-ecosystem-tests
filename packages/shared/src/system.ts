import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, type Client, defaultAccountsSr25519 as devAccounts } from '@e2e-test/networks'
import { setupNetworks } from '@e2e-test/shared'

import type { SubmittableExtrinsic } from '@polkadot/api/types'
import type { Null, Result } from '@polkadot/types'
import type { SpRuntimeDispatchError } from '@polkadot/types/lookup'
import type { IU8a } from '@polkadot/types/types'
import { bufferToU8a, compactAddLength, stringToU8a } from '@polkadot/util'
import type { HexString } from '@polkadot/util/types'

import { expect } from 'vitest'

import { assertExpectedEvents, scheduleInlineCallWithOrigin, scheduleLookupCallWithOrigin } from './helpers/index.js'
import type { RootTestTree } from './types.js'

type SetCodeFn = (code: Uint8Array | HexString) => SubmittableExtrinsic<'promise'>
type AuthorizeUpgradeFn = (codeHash: string | Uint8Array<ArrayBufferLike>) => SubmittableExtrinsic<'promise'>
type ExpectedEvents = Parameters<typeof assertExpectedEvents>[1]

async function runAuthorizeUpgradeScenario(
  client: Client,
  params: {
    call: AuthorizeUpgradeFn
    expectedAfterApply: (hash: IU8a) => ExpectedEvents
  },
) {
  const alice = devAccounts.alice

  const currentWasm = bufferToU8a(Buffer.from((await client.chain.head.wasm).slice(2), 'hex'))
  const currentWasmHash = client.api.registry.hash(currentWasm)

  const call = params.call(currentWasmHash).method
  await scheduleInlineCallWithOrigin(client, call.toHex(), { system: 'Root' })

  await client.dev.newBlock({ count: 1 })
  assertExpectedEvents(await client.api.query.system.events(), [
    {
      type: client.api.events.system.UpgradeAuthorized,
      args: { codeHash: currentWasmHash },
    },
  ])

  const authroizedUpgrade = (await client.api.query.system.authorizedUpgrade()).value
  expect(authroizedUpgrade.codeHash.toHex()).toEqual(currentWasmHash.toHex())

  const applyCall = client.api.tx.system.applyAuthorizedUpgrade(compactAddLength(currentWasm))
  await sendTransaction(applyCall.signAsync(alice))

  await client.dev.newBlock({ count: 1 })

  assertExpectedEvents(await client.api.query.system.events(), params.expectedAfterApply(currentWasmHash))
}

async function runAuthorizeUpgradeAllowToOverrideScenario(
  client: Client,
  params: {
    call: AuthorizeUpgradeFn
  },
) {
  const authorizeHash = async (someHash) => {
    const call = params.call(someHash).method
    await scheduleInlineCallWithOrigin(client, call.toHex(), { system: 'Root' })

    await client.dev.newBlock({ count: 1 })
    assertExpectedEvents(await client.api.query.system.events(), [
      {
        type: client.api.events.system.UpgradeAuthorized,
        args: { codeHash: someHash },
      },
    ])

    const authroizedUpgrade = (await client.api.query.system.authorizedUpgrade()).value
    expect(authroizedUpgrade.codeHash.toHex()).toEqual(someHash.toHex())
  }

  const someHash = client.api.registry.hash(stringToU8a('some data'))
  const someOtherHash = client.api.registry.hash(stringToU8a('some other data'))

  await authorizeHash(someHash) // authorize some hash
  await authorizeHash(someOtherHash) // then authorize different hash and expect the latter to be set
}

async function runSetCodeScenario(
  client: Client,
  params: {
    call: SetCodeFn
    expectedAfterSchedule: ExpectedEvents
  },
) {
  const alice = devAccounts.alice

  // fund Alice (preimage for WASM is expensive)
  await client.dev.setStorage({
    System: {
      account: [[[alice.address], { providers: 1, data: { free: 100000 * 1e10 } }]],
    },
  })

  const currentWasm = Buffer.from((await client.chain.head.wasm).slice(2), 'hex')

  const call = params.call(compactAddLength(currentWasm)).method

  const preimageTx = client.api.tx.preimage.notePreimage(call.toHex())
  const preimageHash = call.hash
  await sendTransaction(preimageTx.signAsync(alice))
  await client.dev.newBlock({ count: 1 })

  assertExpectedEvents(await client.api.query.system.events(), [
    { type: client.api.events.preimage.Noted, args: { hash_: preimageHash } },
  ])

  await scheduleLookupCallWithOrigin(client, { hash: preimageHash, len: call.encodedLength }, { system: 'Root' })
  await client.dev.newBlock({ count: 1 })

  assertExpectedEvents(await client.api.query.system.events(), params.expectedAfterSchedule)

  // sanity: extrinsic still works after (failed/successful) upgrade attempt
  const remarkContent = stringToU8a('still working')
  const remarkCall = client.api.tx.system.remarkWithEvent(compactAddLength(remarkContent))
  await sendTransaction(remarkCall.signAsync(alice))
  await client.dev.newBlock({ count: 1 })

  assertExpectedEvents(await client.api.query.system.events(), [
    {
      type: client.api.events.system.Remarked,
      args: { hash_: client.api.registry.hash(remarkContent) },
    },
  ])
}

export async function setCodeTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>) {
  const [client] = await setupNetworks(chain)
  return runSetCodeScenario(client, {
    call: client.api.tx.system.setCode,
    expectedAfterSchedule: [
      {
        type: client.api.events.scheduler.Dispatched,
        args: { result: (r: Result<Null, SpRuntimeDispatchError>) => r.isErr }, // expected failure
      },
    ],
  })
}

export async function setCodeWithoutChecksTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>) {
  const [client] = await setupNetworks(chain)
  return runSetCodeScenario(client, {
    call: client.api.tx.system.setCodeWithoutChecks,
    expectedAfterSchedule: [
      {
        type: client.api.events.scheduler.Dispatched,
        args: { result: (r: Result<Null, SpRuntimeDispatchError>) => r.isOk }, // expected success
      },
      { type: client.api.events.system.CodeUpdated },
    ],
  })
}

export async function authorizeUpgradeTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>) {
  const [client] = await setupNetworks(chain)
  return runAuthorizeUpgradeScenario(client, {
    call: client.api.tx.system.authorizeUpgrade,
    expectedAfterApply: (hash) => [
      { type: client.api.events.system.RejectedInvalidAuthorizedUpgrade, args: { codeHash: hash } },
    ],
  })
}

export async function authorizeUpgradeWithoutChecksTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>) {
  const [client] = await setupNetworks(chain)
  return runAuthorizeUpgradeScenario(client, {
    call: client.api.tx.system.authorizeUpgradeWithoutChecks,
    expectedAfterApply: () => [{ type: client.api.events.system.CodeUpdated }],
  })
}

export async function authorizeUpgradeAllowToOverride<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>) {
  const [client] = await setupNetworks(chain)
  return runAuthorizeUpgradeAllowToOverrideScenario(client, {
    call: client.api.tx.system.authorizeUpgrade,
  })
}

export async function authorizeUpgradeWithoutChecksAllowToOverride<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>) {
  const [client] = await setupNetworks(chain)
  return runAuthorizeUpgradeAllowToOverrideScenario(client, {
    call: client.api.tx.system.authorizeUpgradeWithoutChecks,
  })
}

export function systemE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: { testSuiteName: string; addressEncoding: number }): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      {
        kind: 'test',
        label: 'set_code doesnt allow upgrade to the same wasm',
        testFn: async () => await setCodeTests(chain),
      },
      {
        kind: 'test',
        label: 'set_code_without_checks allows upgrade to the same wasm',
        testFn: async () => await setCodeWithoutChecksTests(chain),
      },
      {
        kind: 'test',
        label: 'authorize_upgrade_without_checks allows upgrade to the same wasm',
        testFn: async () => await authorizeUpgradeWithoutChecksTests(chain),
      },
      {
        kind: 'test',
        label: 'authorize_upgrade doesnt allow upgrade to the same was',
        testFn: async () => await authorizeUpgradeTests(chain),
      },
      {
        kind: 'test',
        label: 'authorize_upgrade allow to override previously authorized one',
        testFn: async () => await authorizeUpgradeAllowToOverride(chain),
      },
      {
        kind: 'test',
        label: 'authorize_upgrade_without_checks allow to override previously authorized one',
        testFn: async () => await authorizeUpgradeWithoutChecksAllowToOverride(chain),
      },
    ],
  }
}
