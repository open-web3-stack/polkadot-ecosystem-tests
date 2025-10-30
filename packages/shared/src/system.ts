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

import {
  assertExpectedEvents,
  createXcmTransactSend,
  getXcmRoute,
  scheduleInlineCallWithOrigin,
  scheduleLookupCallWithOrigin,
  type TestConfig,
} from './helpers/index.js'
import type { RootTestTree } from './types.js'

type SetCodeFn = (code: Uint8Array | HexString) => SubmittableExtrinsic<'promise'>
type AuthorizeUpgradeFn = (codeHash: string | Uint8Array<ArrayBufferLike>) => SubmittableExtrinsic<'promise'>
type ExpectedEvents = Parameters<typeof assertExpectedEvents>[1]

/**
 * Runs the authorize upgrade + apply authorized upgrade scenario
 * Scenario will fetch WASM from :code storage thus effectively trying to upgrade to the same WASM as currently used
 *
 * Focus of this test is solely the RU's authorization + application process
 *
 * Calls are run locally via scheduler to impersonate Root account
 *
 * via `call` param allows to either use `authorizeUpgrade` or `authorizeUpgradeWithoutChecks`
 *
 * 1. Fetches current runtime WASM and hashes it.
 * 2. Schedules an authorizeUpgrade call as Root using the data from step 1.
 * 4. Applies the upgrade with applyAuthorizedUpgrade using Alice account (non-root account).
 * 5. Verifies expected events as given by the param `expectedAfterApply`
 */
async function runAuthorizeUpgradeScenario(
  client: Client,
  testConfig: TestConfig,
  params: {
    call: AuthorizeUpgradeFn
    expectedAfterApply: (hash: IU8a) => ExpectedEvents
  },
) {
  const alice = devAccounts.alice

  const currentWasm = bufferToU8a(Buffer.from((await client.chain.head.wasm).slice(2), 'hex'))
  const currentWasmHash = client.api.registry.hash(currentWasm)

  const call = params.call(currentWasmHash).method
  await scheduleInlineCallWithOrigin(client, call.toHex(), { system: 'Root' }, testConfig.blockProvider)

  await client.dev.newBlock({ count: 1 })

  assertExpectedEvents(await client.api.query.system.events(), [
    {
      type: client.api.events.system.UpgradeAuthorized,
      args: { codeHash: currentWasmHash },
    },
  ])

  const authorizedUpgrade = (await client.api.query.system.authorizedUpgrade()).value
  expect(authorizedUpgrade.codeHash.toHex()).toEqual(currentWasmHash.toHex())

  const applyCall = client.api.tx.system.applyAuthorizedUpgrade(compactAddLength(currentWasm))
  await sendTransaction(applyCall.signAsync(alice))

  await client.dev.newBlock({ count: 1 })

  if (client.config.isRelayChain) {
    assertExpectedEvents(await client.api.query.system.events(), params.expectedAfterApply(currentWasmHash))
  } else {
    const eventsAfterFirstBlock = await client.api.query.system.events()
    await client.dev.newBlock({ count: 1 })
    const eventsAfterSecondBlock = await client.api.query.system.events()
    assertExpectedEvents(
      eventsAfterFirstBlock.concat(eventsAfterSecondBlock),
      params.expectedAfterApply(currentWasmHash),
    )
  }
}

/**
 * Runs the authorize upgrade + apply authorized upgrade scenario
 * Scenario will fetch WASM from :code storage thus effectively trying to upgrade to the same WASM as currently used
 * Calls are run via scheduler on Relay using XCM Transact to send the actual call to the destination parachain
 *
 * Focus of this test is solely the RU's authorization + application process
 *
 * via `call` param allows to either use `authorizeUpgrade` or `authorizeUpgradeWithoutChecks`
 *
 * 1. Fetches current runtime WASM and hashes it.
 * 2. Creates XCM Transact call with the authorizeUpgrade call as payload using wasm data from step 1
 * 3. Applies the upgrade locally on the destination parachain
 *    with applyAuthorizedUpgrade using Alice account (non-root account).
 * 5. Verifies expected events as given by the param `expectedAfterApply`
 */
async function runAuthorizeUpgradeScenarioViaRemoteScheduler(
  governanceClient: Client,
  toBeUpgradedClient: Client,
  testConfig: TestConfig,
  params: {
    call: AuthorizeUpgradeFn
    expectedAfterApply: (hash: IU8a) => ExpectedEvents
  },
) {
  const alice = devAccounts.alice

  const currentWasm = bufferToU8a(Buffer.from((await toBeUpgradedClient.chain.head.wasm).slice(2), 'hex'))
  const currentWasmHash = toBeUpgradedClient.api.registry.hash(currentWasm)

  const call = params.call(currentWasmHash).method

  const dest = getXcmRoute(governanceClient.config, toBeUpgradedClient.config)
  const xcmTx = createXcmTransactSend(governanceClient, dest, call.toHex(), 'Superuser').method

  await scheduleInlineCallWithOrigin(governanceClient, xcmTx.toHex(), { system: 'Root' }, testConfig.blockProvider)
  await governanceClient.dev.newBlock({ count: 1 })
  await toBeUpgradedClient.dev.newBlock({ count: 1 })

  const authorizedUpgrade = (await toBeUpgradedClient.api.query.system.authorizedUpgrade()).value
  expect(authorizedUpgrade.codeHash.toHex()).toEqual(currentWasmHash.toHex())

  const applyCall = toBeUpgradedClient.api.tx.system.applyAuthorizedUpgrade(compactAddLength(currentWasm))
  await sendTransaction(applyCall.signAsync(alice))

  await toBeUpgradedClient.dev.newBlock({ count: 1 })
  const eventsAfterFirstBlock = await toBeUpgradedClient.api.query.system.events()
  await toBeUpgradedClient.dev.newBlock({ count: 1 })
  const eventsAfterSecondBlock = await toBeUpgradedClient.api.query.system.events()

  assertExpectedEvents(eventsAfterFirstBlock.concat(eventsAfterSecondBlock), params.expectedAfterApply(currentWasmHash))
}

/**
 * Runs multiple authorizeUpgrade calls to confirm possibility to override previously authorized code
 * Calls are run locally via scheduler to impersonate Root account
 *
 * via `call` param allows to either use `authorizeUpgrade` or `authorizeUpgradeWithoutChecks`
 *
 * 1. Schedules an authorizeUpgrade call using some hash (exact hash is not important)
 * 2. Asserts expected `UpgradeAuthorized` event and `authorizedUpgrade` storage against expected hash
 * 3. Schedules another authorizeUpgrade call using some hash different than hash from step 1
 * 4. Asserts expected `UpgradeAuthorized` event and `authorizedUpgrade` storage against expected different hash
 */
async function runAuthorizeUpgradeAllowToOverrideScenario(
  client: Client,
  testConfig: TestConfig,
  params: {
    call: AuthorizeUpgradeFn
  },
) {
  const authorizeHash = async (someHash) => {
    const call = params.call(someHash).method
    await scheduleInlineCallWithOrigin(client, call.toHex(), { system: 'Root' }, testConfig.blockProvider)

    await client.dev.newBlock({ count: 1 })
    assertExpectedEvents(await client.api.query.system.events(), [
      {
        type: client.api.events.system.UpgradeAuthorized,
        args: { codeHash: someHash },
      },
    ])

    const authorizedUpgrade = (await client.api.query.system.authorizedUpgrade()).value
    expect(authorizedUpgrade.codeHash.toHex()).toEqual(someHash.toHex())
  }

  const someHash = client.api.registry.hash(stringToU8a('some data'))
  const someOtherHash = client.api.registry.hash(stringToU8a('some other data'))

  await authorizeHash(someHash) // authorize some hash
  await authorizeHash(someOtherHash) // then authorize different hash and expect the latter to be set
}

/**
 * Runs multiple authorizeUpgrade calls to confirm possibility to override previously authorized code
 * Calls are run via scheduler on Governance Chain using XCM Transact to send the actual call to the destination parachain
 *
 * Focus of this test is solely the RU's authorization + application process
 *
 * via `call` param allows to either use `authorizeUpgrade` or `authorizeUpgradeWithoutChecks`
 *
 * 1. Schedules an authorizeUpgrade call using some hash (exact hash is not important)
 * 2. Asserts expected `UpgradeAuthorized` event and `authorizedUpgrade` storage against expected hash
 * 3. Schedules another authorizeUpgrade call using some hash different than hash from step 1
 * 4. Asserts expected `UpgradeAuthorized` event and `authorizedUpgrade` storage against expected different hash
 */
async function runAuthorizeUpgradeAllowToOverrideScenarioViaRemoteScheduler(
  governanceChain: Client,
  toBeUpgradedClient: Client,
  testConfig: TestConfig,
  params: {
    call: AuthorizeUpgradeFn
  },
) {
  const authorizeHash = async (someHash) => {
    const call = params.call(someHash).method
    const dest = getXcmRoute(governanceChain.config, toBeUpgradedClient.config)
    const xcmTx = createXcmTransactSend(governanceChain, dest, call.toHex(), 'Superuser').method
    await scheduleInlineCallWithOrigin(governanceChain, xcmTx.toHex(), { system: 'Root' }, testConfig.blockProvider)

    await governanceChain.dev.newBlock({ count: 1 })
    await toBeUpgradedClient.dev.newBlock({ count: 1 })

    assertExpectedEvents(await toBeUpgradedClient.api.query.system.events(), [
      {
        type: toBeUpgradedClient.api.events.system.UpgradeAuthorized,
        args: { codeHash: someHash },
      },
    ])

    const authorizedUpgrade = (await toBeUpgradedClient.api.query.system.authorizedUpgrade()).value
    expect(authorizedUpgrade.codeHash.toHex()).toEqual(someHash.toHex())
  }

  const someHash = toBeUpgradedClient.api.registry.hash(stringToU8a('some data'))
  const someOtherHash = toBeUpgradedClient.api.registry.hash(stringToU8a('some other data'))

  await authorizeHash(someHash) // authorize some hash
  await authorizeHash(someOtherHash) // then authorize different hash and expect the latter to be set
}

/**
 * Runs upgrade scenario via direct set_code
 * Scenario will fetch WASM from :code storage thus effectively trying to upgrade to the same WASM as currently used
 * Calls are run locally via scheduler to impersonate Root account
 *
 * Focus of this test is to solely verify working of direct runtime upgrade (as opposed to 2-step apply+authorize method)
 *
 * via `call` param allows to either use `setCode` or `setCodeWithoutChecks`
 *
 * 1. Fetches current runtime WASM and hashes it.
 * 2. Schedules an setCode call as Root using the data from step 1.
 * 3. Verifies expected events as given by the param `expectedAfterSchedule`
 * 4. Executes remark (could be any other) extrinsic to confirm WASM is still functional after enacted
 */
async function runSetCodeScenario(
  client: Client,
  testConfig: TestConfig,
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

  await scheduleLookupCallWithOrigin(
    client,
    { hash: preimageHash, len: call.encodedLength },
    { system: 'Root' },
    testConfig.blockProvider,
  )
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

/**
 * Runs upgrade scenario via scheduler on remote chain (that can also act as root)
 * Scenario will fetch WASM from :code storage thus effectively trying to upgrade to the same WASM as currently used
 * Calls are run via scheduler on chosen chain using XCM Transact to send the actual call to the destination parachain
 *
 * Focus of this test is to verify that XCM containing WASM blob is too big to be sent between chosen scheduling chain and parachains
 *
 * via `call` param allows to either use `setCode` or `setCodeWithoutChecks`
 *
 * 1. Fetches current runtime WASM and hashes it.
 * 2. Schedules an setCode call as Root using the data from step 1.
 * 3. Verifies expected events as given by the param `expectedAfterSchedule`
 */
async function runSetCodeScenarioViaRemoteScheduler(
  governanceClient: Client,
  toBeUpgradedClient: Client,
  testConfig: TestConfig,
  params: {
    call: SetCodeFn
    expectedAfterSchedule: ExpectedEvents
  },
) {
  const alice = devAccounts.alice

  // fund Alice (preimage for WASM is expensive)
  await governanceClient.dev.setStorage({
    System: {
      account: [[[alice.address], { providers: 1, data: { free: 100000 * 1e10 } }]],
    },
  })

  const currentWasm = Buffer.from((await toBeUpgradedClient.chain.head.wasm).slice(2), 'hex')

  const call = params.call(compactAddLength(currentWasm)).method

  const dest = getXcmRoute(governanceClient.config, toBeUpgradedClient.config)
  const xcmTx = createXcmTransactSend(governanceClient, dest, call.toHex(), 'Superuser').method

  const preimageTx = governanceClient.api.tx.preimage.notePreimage(xcmTx.toHex())
  const preimageHash = xcmTx.hash
  await sendTransaction(preimageTx.signAsync(alice))
  await governanceClient.dev.newBlock({ count: 1 })

  assertExpectedEvents(await governanceClient.api.query.system.events(), [
    { type: governanceClient.api.events.preimage.Noted, args: { hash_: preimageHash } },
  ])

  await scheduleLookupCallWithOrigin(
    governanceClient,
    { hash: preimageHash, len: xcmTx.encodedLength },
    { system: 'Root' },
    testConfig.blockProvider,
  )
  await governanceClient.dev.newBlock({ count: 1 })

  assertExpectedEvents(await governanceClient.api.query.system.events(), params.expectedAfterSchedule)
}

/**
 * Tests `setCode` flow — ensures runtime upgrade to the same WASM fails.
 */
export async function setCodeTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)
  return runSetCodeScenario(client, testConfig, {
    call: client.api.tx.system.setCode,
    expectedAfterSchedule: [
      {
        type: client.api.events.scheduler.Dispatched,
        args: {
          result: (r: Result<Null, SpRuntimeDispatchError>) =>
            r.isErr && client.api.errors.system.SpecVersionNeedsToIncrease.is(r.asErr.asModule),
        }, // expected failure
      },
    ],
  })
}

/**
 * Tests `setCode` flow — ensures runtime upgrade to the same WASM fails due to XCM exceeding message size limits
 */
export async function setCodeViaRemoteSchedulerTests<
  TCustomRelay extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
  TCustomPara extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(
  governanceChain: Chain<TCustomRelay, TInitStoragesRelay>,
  toBeUpgradedChain: Chain<TCustomPara, TInitStoragesPara>,
  testConfig: TestConfig,
) {
  const [governanceClient, toBeUpgradedClient] = await setupNetworks(governanceChain, toBeUpgradedChain)
  return runSetCodeScenarioViaRemoteScheduler(governanceClient, toBeUpgradedClient, testConfig, {
    call: toBeUpgradedClient.api.tx.system.setCode,
    expectedAfterSchedule: [
      {
        type: governanceClient.api.events.scheduler.Dispatched,
        args: {
          result: (r: Result<Null, SpRuntimeDispatchError>) =>
            r.isErr &&
            (governanceClient.api.errors.xcmPallet || governanceClient.api.errors.polkadotXcm).SendFailure.is(
              r.asErr.asModule,
            ),
        }, // expected failure
      },
    ],
  })
}

/**
 * Tests `setCodeWithoutChecks` flow — ensures upgrade to same WASM succeeds.
 */
export async function setCodeWithoutChecksTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)
  return runSetCodeScenario(client, testConfig, {
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

/**
 * Tests `authorizeUpgrade` flow — upgrade to same WASM should fail validation.
 */
export async function authorizeUpgradeTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)
  return runAuthorizeUpgradeScenario(client, testConfig, {
    call: client.api.tx.system.authorizeUpgrade,
    expectedAfterApply: (hash) => [
      {
        type: client.api.events.system.RejectedInvalidAuthorizedUpgrade,
        args: {
          codeHash: hash,
          error: (r: SpRuntimeDispatchError) => client.api.errors.system.SpecVersionNeedsToIncrease.is(r.asModule),
        },
      },
    ],
  })
}

/**
 * Tests `authorizeUpgradeWithoutChecks` — upgrade to same WASM should succeed.
 */
export async function authorizeUpgradeWithoutChecksTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  let expectedEvents: ExpectedEvents = []
  if (chain.isRelayChain) {
    expectedEvents = [{ type: client.api.events.system.CodeUpdated }]
  } else {
    expectedEvents = [
      { type: client.api.events.parachainSystem.ValidationFunctionStored },
      { type: client.api.events.parachainSystem.ValidationFunctionApplied },
      { type: client.api.events.system.CodeUpdated },
    ]
  }

  return runAuthorizeUpgradeScenario(client, testConfig, {
    call: client.api.tx.system.authorizeUpgradeWithoutChecks,
    expectedAfterApply: () => expectedEvents,
  })
}

/**
 * Tests `authorizeUpgrade` executed via Governance Chain (XCM Transact) — upgrade to same WASM should fail validation.
 */
export async function authorizeUpgradeViaRemoteSchedulerTests<
  TCustomRelay extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
  TCustomPara extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(
  governanceChain: Chain<TCustomRelay, TInitStoragesRelay>,
  toBeUpgradedChain: Chain<TCustomPara, TInitStoragesPara>,
  testConfig: TestConfig,
) {
  const [governanceClient, toBeUpgradedClient] = await setupNetworks(governanceChain, toBeUpgradedChain)
  return runAuthorizeUpgradeScenarioViaRemoteScheduler(governanceClient, toBeUpgradedClient, testConfig, {
    call: toBeUpgradedClient.api.tx.system.authorizeUpgrade,
    expectedAfterApply: (hash) => [
      {
        type: toBeUpgradedClient.api.events.system.RejectedInvalidAuthorizedUpgrade,
        args: {
          codeHash: hash,
          error: (r: SpRuntimeDispatchError) =>
            toBeUpgradedClient.api.errors.system.SpecVersionNeedsToIncrease.is(r.asModule),
        },
      },
    ],
  })
}

/**
 * Tests `authorizeUpgrade` executed via Governance Chain (XCM Transact) — upgrade to same WASM should succeed.
 */
export async function authorizeUpgradeWithoutChecksViaRemoteSchedulerTests<
  TCustomRelay extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
  TCustomPara extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(
  governanceChain: Chain<TCustomRelay, TInitStoragesRelay>,
  toBeUpgradedChain: Chain<TCustomPara, TInitStoragesPara>,
  testConfig: TestConfig,
) {
  const [governanceClient, toBeUpgradedClient] = await setupNetworks(governanceChain, toBeUpgradedChain)

  let expectedEvents: ExpectedEvents = []
  if (toBeUpgradedChain.isRelayChain) {
    expectedEvents = [{ type: toBeUpgradedClient.api.events.system.CodeUpdated }]
  } else {
    expectedEvents = [
      { type: toBeUpgradedClient.api.events.parachainSystem.ValidationFunctionStored },
      { type: toBeUpgradedClient.api.events.parachainSystem.ValidationFunctionApplied },
      { type: toBeUpgradedClient.api.events.system.CodeUpdated },
    ]
  }
  return runAuthorizeUpgradeScenarioViaRemoteScheduler(governanceClient, toBeUpgradedClient, testConfig, {
    call: toBeUpgradedClient.api.tx.system.authorizeUpgradeWithoutChecks,
    expectedAfterApply: () => expectedEvents,
  })
}

/**
 * Tests`authorizeUpgrade` ability to override previously authorized upgrade executed via Relay Chain (XCM Transact)
 */
export async function authorizeUpgradeAllowToOverrideViaRemoteSchedulerTests<
  TCustomRelay extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
  TCustomPara extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(
  governanceChain: Chain<TCustomRelay, TInitStoragesRelay>,
  toBeUpgradedChain: Chain<TCustomPara, TInitStoragesPara>,
  testConfig: TestConfig,
) {
  const [governanceClient, toBeUpgradedClient] = await setupNetworks(governanceChain, toBeUpgradedChain)
  return runAuthorizeUpgradeAllowToOverrideScenarioViaRemoteScheduler(
    governanceClient,
    toBeUpgradedClient,
    testConfig,
    {
      call: toBeUpgradedClient.api.tx.system.authorizeUpgrade,
    },
  )
}

/**
 * Tests `authorizeUpgradeWithoutChecks` ability to override previously authorized upgrade executed via Governance Chain (XCM Transact)
 */
export async function authorizeUpgradeWithoutChecksAllowToOverrideViaRemoteSchedulerTests<
  TCustomRelay extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
  TCustomPara extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(
  governanceChain: Chain<TCustomRelay, TInitStoragesRelay>,
  toBeUpgradedChain: Chain<TCustomPara, TInitStoragesPara>,
  testConfig: TestConfig,
) {
  const [governanceClient, toBeUpgradedClient] = await setupNetworks(governanceChain, toBeUpgradedChain)
  return runAuthorizeUpgradeAllowToOverrideScenarioViaRemoteScheduler(
    governanceClient,
    toBeUpgradedClient,
    testConfig,
    {
      call: toBeUpgradedClient.api.tx.system.authorizeUpgradeWithoutChecks,
    },
  )
}

/**
 * Tests `authorizeUpgrade` ability to override previously authorized upgrade.
 */
export async function authorizeUpgradeAllowToOverride<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)
  return runAuthorizeUpgradeAllowToOverrideScenario(client, testConfig, {
    call: client.api.tx.system.authorizeUpgrade,
  })
}

/**
 * Tests `authorizeUpgradeWithoutChecks` ability to override previously authorized upgrade.
 */
export async function authorizeUpgradeWithoutChecksAllowToOverride<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)
  return runAuthorizeUpgradeAllowToOverrideScenario(client, testConfig, {
    call: client.api.tx.system.authorizeUpgradeWithoutChecks,
  })
}

/**
 * System upgrade scenarios for relay chains
 *
 * To be used by chains with local Scheduler and Preimage pallets available
 */
export function systemE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      {
        kind: 'test',
        label: 'set_code doesnt allow upgrade to the same wasm',
        testFn: async () => await setCodeTests(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'set_code_without_checks allows upgrade to the same wasm',
        testFn: async () => await setCodeWithoutChecksTests(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'authorize_upgrade_without_checks allows upgrade to the same wasm',
        testFn: async () => await authorizeUpgradeWithoutChecksTests(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'authorize_upgrade doesnt allow upgrade to the same wasm',
        testFn: async () => await authorizeUpgradeTests(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'authorize_upgrade allows to override previously authorized one',
        testFn: async () => await authorizeUpgradeAllowToOverride(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'authorize_upgrade_without_checks allows to override previously authorized one',
        testFn: async () => await authorizeUpgradeWithoutChecksAllowToOverride(chain, testConfig),
      },
    ],
  }
}

/**
 * Set of system upgrade scenarios prepared for parachains
 *
 * To be used by chains with local Scheduler and Preimage pallets available
 */
export function systemE2ETestsForParaWithScheduler<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      // TODO: Commented out tests dont work, not sure if thats expected or not
      //       (scheduler.Dispatched error: parachainSystem.ValidationDataNotAvailable)
      // {
      //   kind: 'test',
      //   label: 'set_code doesnt allow upgrade to the same wasm',
      //   testFn: async () => await setCodeTests(chain, testConfig),
      // },
      // {
      //   kind: 'test',
      //   label: 'set_code_without_checks allows upgrade to the same wasm',
      //   testFn: async () => await setCodeWithoutChecksTests(chain, testConfig),
      // },
      {
        kind: 'test',
        label: 'authorize_upgrade_without_checks allows upgrade to the same wasm',
        testFn: async () => await authorizeUpgradeWithoutChecksTests(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'authorize_upgrade doesnt allow upgrade to the same wasm',
        testFn: async () => await authorizeUpgradeTests(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'authorize_upgrade allows to override previously authorized one',
        testFn: async () => await authorizeUpgradeAllowToOverride(chain, testConfig),
      },
      {
        kind: 'test',
        label: 'authorize_upgrade_without_checks allows to override previously authorized one',
        testFn: async () => await authorizeUpgradeWithoutChecksAllowToOverride(chain, testConfig),
      },
    ],
  }
}

/**
 * System upgrade scenarios using other chain's scheduler
 *
 * To be used by chains that doesn't provide Scheduler or Preimage pallet locally
 * and trust Governance Chain to execute calls as Root origin
 */
export function systemE2ETestsViaRemoteScheduler<
  TCustomRelay extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
  TCustomPara extends Record<string, unknown> | undefined,
  TInitStoragesPara extends Record<string, Record<string, any>> | undefined,
>(
  governanceChain: Chain<TCustomRelay, TInitStoragesRelay>,
  toBeUpgradedChain: Chain<TCustomPara, TInitStoragesPara>,
  testConfig: TestConfig,
): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      {
        kind: 'test',
        label: `authorize_upgrade doesnt allow upgrade to the same wasm (via ${governanceChain.name})`,
        testFn: async () =>
          await authorizeUpgradeViaRemoteSchedulerTests(governanceChain, toBeUpgradedChain, testConfig),
      },
      {
        kind: 'test',
        label: `authorize_upgrade_without_checks allows upgrade to the same wasm (via ${governanceChain.name})`,
        testFn: async () =>
          await authorizeUpgradeWithoutChecksViaRemoteSchedulerTests(governanceChain, toBeUpgradedChain, testConfig),
      },
      {
        kind: 'test',
        label: `authorize_upgrade allows to override previously authorized one (via ${governanceChain.name})`,
        testFn: async () =>
          await authorizeUpgradeAllowToOverrideViaRemoteSchedulerTests(governanceChain, toBeUpgradedChain, testConfig),
      },
      {
        kind: 'test',
        label: `authorize_upgrade_without_checks allows to override previously authorized one (via ${governanceChain.name})`,
        testFn: async () =>
          await authorizeUpgradeWithoutChecksAllowToOverrideViaRemoteSchedulerTests(
            governanceChain,
            toBeUpgradedChain,
            testConfig,
          ),
      },
      {
        kind: 'test',
        label: `expecting set_code to fail as sending WASM from relay to para should exceed XCM limits (via ${governanceChain.name})`,
        testFn: async () => await setCodeViaRemoteSchedulerTests(governanceChain, toBeUpgradedChain, testConfig),
      },
    ],
  }
}
