import type { StorageValues } from '@acala-network/chopsticks'
import { sendTransaction, setupCheck } from '@acala-network/chopsticks-testing'

import { type Chain, defaultAccounts } from '@e2e-test/networks'

import type { ApiPromise } from '@polkadot/api'
import { decodeAddress, encodeAddress } from '@polkadot/keyring'
import type { KeyringPair } from '@polkadot/keyring/types'
import type { EventRecord } from '@polkadot/types/interfaces'
import type { FrameSystemAccountInfo, PalletStakingValidatorPrefs } from '@polkadot/types/lookup'
import type { IsEvent } from '@polkadot/types/metadata/decorate/types'
import type { AnyTuple, Codec, IEvent } from '@polkadot/types/types'
import type { HexString } from '@polkadot/util/types'

import { assert, expect } from 'vitest'

import { match } from 'ts-pattern'
import type { Client } from '../types.js'

const { check, checkEvents, checkHrmp, checkSystemEvents, checkUmp } = setupCheck({
  expectFn: (x: any) => ({
    toMatchSnapshot(msg?: string): void {
      expect(x).toMatchSnapshot(msg)
    },
    toMatch(value: any, _msg?: string): void {
      expect(x).toMatch(value)
    },
    toMatchObject(value: any, _msg?: string): void {
      expect(x).toMatchObject(value)
    },
  }),
  redactOptions: {
    overrides: {
      proofSize: {
        number: 1,
      },
      refTime: {
        number: 1,
      },
    },
  },
})

export { check, checkEvents, checkHrmp, checkSystemEvents, checkUmp }

/**
 * Compare two PJS objects for equality using their JSON representation.
 * This avoids issues with metadata differences while providing detailed diff information on failure.
 *
 * @param actual The actual PJS object
 * @param expected The expected PJS object
 * @param message Optional message to display on failure
 */
export function expectPjsEqual(actual: any, expected: any, message?: string): void {
  expect(actual.toJSON(), message).toEqual(expected.toJSON())
}

/**
 * Compare the selected properties of two objects.
 *
 * Fails if any of the properties to be compared is different.
 *
 * @param obj1
 * @param obj2
 * @param properties List of properties to be compared
 * @param propertiesToBeSkipped List of properties to not be compared
 * @param msgFun Function that returns a message to be displayed when the comparison fails, based on
 *        the property name - it may capture the objects from the calling function's scope.
 * @param optErrorMsg Optional error message useful when e.g. using this function inside a loop, to
 *        identify failing iteration.
 */
export function objectCmp(
  obj1: object,
  obj2: object,
  properties: string[],
  propertiesToBeSkipped: string[],
  msgFun: (p: string) => string,
  optErrorMsg?: string,
) {
  for (const prop of properties) {
    if (propertiesToBeSkipped.includes(prop)) {
      continue
    }

    const cmp = obj1[prop].eq(obj2[prop])
    if (!cmp) {
      const msg = msgFun(prop)
      let errorMessage: string
      if (optErrorMsg === null || optErrorMsg === undefined) {
        errorMessage = msg
      } else {
        errorMessage = `${optErrorMsg}\n${msg}`
      }
      expect(cmp, errorMessage).toBe(true)
    }
  }
}

/**
 * This enum is used when scheduling calls, to know whether the calling environment:
 * 1. uses a local block provider e.g. relay chains, or some system parachains
 * 2. uses a non-local block provider e.g. some system parachain that need relay block numbers for proxies or
 *    call scheduling
 */
export type BlockProvider = 'Local' | 'NonLocal'

/** Whether async backing is enabled or disabled on the querying parachain. */
export type AsyncBacking = 'Enabled' | 'Disabled'

/**
 * Given a PJS client and a call, modify the `scheduler` pallet's `agenda` storage to execute the list of extrinsics
 * in the next block.
 *
 * The calls can be either inline calls or lookup calls, which in the latter case *must* have been noted
 * in the storage of the chain's `preimage` pallet with a `notePreimage` extrinsic.
 *
 * @param blockProvider Whether the calls are being scheduled on a chain that uses a local or nonlocal block provider.
 *        This chain's runtime *must* have the scheduler pallet available.
 */
export async function scheduleCallListWithOrigin(
  client: {
    api: ApiPromise
    dev: {
      setStorage: (values: StorageValues, blockHash?: string) => Promise<any>
    }
  },
  calls: {
    call:
      | { Inline: any }
      | {
          Lookup: {
            hash: any
            len: any
          }
        }
    origin: any
  }[],
  blockProvider: BlockProvider = 'Local',
) {
  const scheduledBlock = await match(blockProvider)
    .with('Local', async () => (await client.api.rpc.chain.getHeader()).number.toNumber() + 1)
    .with('NonLocal', async () =>
      ((await client.api.query.parachainSystem.lastRelayChainBlockNumber()) as any).toNumber(),
    )
    .exhaustive()

  await client.dev.setStorage({
    Scheduler: {
      agenda: [[[scheduledBlock], calls]],
      incompleteSince: scheduledBlock,
    },
  })
}

/**
 * Given a PJS client and a list of inline calls with the same origin, modify the `scheduler`
 * pallet's `agenda` storage to execute the extrinsic in the next block.
 */
export async function scheduleInlineCallListWithSameOrigin(
  client: {
    api: ApiPromise
    dev: {
      setStorage: (values: StorageValues, blockHash?: string) => Promise<any>
    }
  },
  encodedCall: HexString[],
  origin: any,
  blockProvider: BlockProvider = 'Local',
) {
  const callList = encodedCall.map((call) => ({ call: { Inline: call }, origin }))
  await scheduleCallListWithOrigin(client, callList, blockProvider)
}

/**
 * Given a PJS client and a call, modify the `scheduler` pallet's `agenda` storage to execute the extrinsic in the next
 * block.
 *
 * The call can be either an inline call or a lookup call, which in the latter case *must* have been noted
 * in the storage of the chain's `preimage` pallet with a `notePreimage` extrinsic.
 *
 * @param blockProvider Whether the call is being scheduled on a chain that uses a local or nonlocal block provider.
 *        This chain's runtime *must* have the scheduler pallet available.
 */
export async function scheduleCallWithOrigin(
  client: {
    api: ApiPromise
    dev: {
      setStorage: (values: StorageValues, blockHash?: string) => Promise<any>
    }
  },
  call:
    | { Inline: any }
    | {
        Lookup: {
          hash: any
          len: any
        }
      },
  origin: any,
  blockProvider: BlockProvider = 'Local',
) {
  await scheduleCallListWithOrigin(client, [{ call, origin }], blockProvider)
}

/**
 * Given a PJS client and an inline call with a given origin, modify the
 * `scheduler` pallet's `agenda` storage to execute the call in the next block.
 */
export async function scheduleInlineCallWithOrigin(
  client: {
    api: ApiPromise
    dev: {
      setStorage: (values: StorageValues, blockHash?: string) => Promise<any>
    }
  },
  encodedCall: HexString,
  origin: any,
  blockProvider: BlockProvider = 'Local',
) {
  await scheduleCallWithOrigin(client, { Inline: encodedCall }, origin, blockProvider)
}

/**
 * Given a PJS client and a lookup call with a given origin, modify the
 * `scheduler` pallet's `agenda` storage to execute the call in the next block.
 */
export async function scheduleLookupCallWithOrigin(
  client: {
    api: ApiPromise
    dev: {
      setStorage: (values: StorageValues, blockHash?: string) => Promise<any>
    }
  },
  lookupCall: { hash: any; len: any },
  origin: any,
  blockProvider: BlockProvider = 'Local',
) {
  await scheduleCallWithOrigin(client, { Lookup: lookupCall }, origin, blockProvider)
}

/**
 * Send an XCM message containing an extrinsic to be executed in a parachain with a given origin.
 *
 * @param client Relay chain or parachain client from which to execute `xcmPallet.send`
 * @param dest MultiLocation destination to which the XCM message is to be sent
 * @param call Hex-encoded identity pallet extrinsic
 * @param origin Origin with which the extrinsic is to be executed at the location parachain
 * @param requireWeightAtMost Reftime/proof size parameters that `send::Transact` may require (only in XCM v4);
 *        sensible defaults are given.
 */
export function createXcmTransactSend(
  client: {
    api: ApiPromise
    dev: {
      setStorage: (values: StorageValues, blockHash?: string) => Promise<any>
    }
  },
  dest: any,
  call: HexString,
  originKind: string,
  requireWeightAtMost = { proofSize: '10000', refTime: '100000000' },
) {
  // The message being sent to the parachain, containing a call to be executed in the parachain:
  const message = {
    V4: [
      {
        UnpaidExecution: {
          weightLimit: 'Unlimited',
          checkOrigin: null,
        },
      },
      {
        Transact: {
          call: {
            encoded: call,
          },
          originKind,
          requireWeightAtMost,
        },
      },
    ],
  }

  return (client.api.tx.xcmPallet || client.api.tx.polkadotXcm).send({ V4: dest }, message)
}

/**
 * Select some validators from the list present in the `Validators` storage item, in the `Staking` pallet.
 *
 * To avoid fetching all validators at once (over a thousand in Jan. 2025), only the first page of validators
 * in storage is considered - the size of the page is provided as an argument.
 *
 * If, in the validator page of the selected size, less than `validatorCount` validators are available, the function
 * will get as close to `validatorCount` as possible.
 *
 * @param api PJS client object.
 * @param pageSize The size of the page to fetch from storage.
 * @param validatorCount The (desired) number of validators to select.
 * @returns A list of at least 1 validator, and at most 16.
 */
export async function getValidators(api: ApiPromise, pageSize: number, validatorCount: number): Promise<string[]> {
  // Between 1 and 16 validators can be nominated by the pool at any time.
  const min_validators = 1
  const max_validators = 16

  assert(pageSize >= max_validators)
  assert(min_validators <= validatorCount && validatorCount <= max_validators)

  // Query the list of validators from the `Validators` storage item in the `staking` pallet.
  const validators = await api.query.staking.validators.entriesPaged({ args: [], pageSize: pageSize })

  const validatorIds: [string, PalletStakingValidatorPrefs][] = validators.map((tuple) => [
    tuple[0].args[0].toString(),
    tuple[1],
  ])

  const selectedValidators: string[] = []

  let ix = 0
  let count = 0
  while (count < validatorCount) {
    const [valAddr, valData] = validatorIds[ix]

    // The pool's nominator should only select validators who still allow for nominators
    // to select them i.e. they have not blocked themselves.
    if (valData.blocked.isFalse) {
      selectedValidators.push(valAddr)
      count += 1
    }

    ix += 1
  }

  assert(selectedValidators.length >= min_validators && selectedValidators.length <= max_validators)

  return selectedValidators
}

/**
 * Create a given number of keypairs, add some funds to them, and bond those funds.
 */
export async function createAndBondAccounts(
  client: {
    api: ApiPromise
    dev: {
      newBlock: (param?: any) => Promise<string>
      setStorage: (values: StorageValues, blockHash?: string) => Promise<any>
    }
  },
  validatorCount: number,
): Promise<KeyringPair[]> {
  const validators: KeyringPair[] = []

  for (let i = 0; i < validatorCount; i++) {
    const validator = defaultAccounts.keyring.addFromUri(`//Validator_${i}`)
    validators.push(validator)
  }

  await client.dev.setStorage({
    System: {
      account: validators.map((v) => [[v.address], { providers: 1, data: { free: 10000e10 } }]),
    },
  })

  for (let i = 0; i < validatorCount; i++) {
    const bondTx = client.api.tx.staking.bond(1000e10, { Staked: null })
    await sendTransaction(bondTx.signAsync(validators[i]))
  }

  await client.dev.newBlock()

  return validators
}

/**
 * Insert the given validators into storage.
 *
 * The `Validators` storage item is *not* meant to be manipulated directly.
 * However, in the case that the test chain has no validators and it is impracticable to call `validate` and wait
 * for the next era, this function can be used.
 *
 * Note also that normally, a successful call to `validate` would also manipulate the `VoterList` in storage, which is
 * not done here
 * For the purposes of most tests (e.g. just verifying that nominating existing validators works), this can be ignored.
 * @param client
 * @param validators
 */
export async function setValidatorsStorage(
  client: {
    api: ApiPromise
    dev: {
      setStorage: (values: StorageValues, blockHash?: string) => Promise<any>
    }
  },
  validators: string[],
) {
  const minCommission = await client.api.query.staking.minCommission()

  await client.dev.setStorage({
    Staking: {
      Validators: validators.map((val) => [
        [val],
        {
          blocked: false,
          commission: minCommission,
        },
      ]),
    },
  })
}

/// -------
/// Fee extraction abstraction
/// -------

/**
 * Normalized fee information extracted from a transaction fee payment event.
 * Different runtimes emit different fee events, but tests only need these three fields.
 */
export interface FeeInfo {
  who: string
  actualFee: bigint
  tip: bigint
}

/**
 * Extracts fee payment information from a list of system events.
 * Different runtimes may have different fee event structures; each can provide its own extractor.
 */
export type FeeExtractor = (events: EventRecord[], api: ApiPromise) => FeeInfo[]

/**
 * Default fee extractor for standard Substrate runtimes using `pallet-transaction-payment`.
 * Handles the standard `TransactionFeePaid { who, actual_fee, tip }` event.
 *
 * This is the default used by `RelayTestConfig` and `ParaTestConfig` when no `feeExtractor` is provided.
 */
export const standardFeeExtractor: FeeExtractor = (events, api) => {
  const results: FeeInfo[] = []
  for (const { event } of events) {
    if (api.events.transactionPayment.TransactionFeePaid.is(event)) {
      results.push({
        who: event.data.who.toString(),
        actualFee: event.data.actualFee.toBigInt(),
        tip: event.data.tip.toBigInt(),
      })
    }
  }
  return results
}

/**
 * Extract fee payment events from the given events.
 * Uses the fee extractor from the test config, or falls back to `standardFeeExtractor`.
 */
export function findFeeEvents(events: EventRecord[], api: ApiPromise, testConfig: TestConfig): FeeInfo[] {
  const extractor = testConfig.feeExtractor ?? standardFeeExtractor
  return extractor(events, api)
}

/**
 * Helper to track transaction fees paid by a set of accounts.
 *
 * Traverses the most recent events, using the given `ApiPromise`, to find transaction fee payment events.
 * It then uses this information to update the given `feeMap`.
 *
 * @param api - The API instance to query events
 * @param feeMap - Map from addresses to their cumulative paid fees
 * @param testConfig - Test configuration, used for address encoding and the fee extractor
 * @returns Updated fee map with new fees added
 */
export async function updateCumulativeFees(
  api: ApiPromise,
  feeMap: Map<string, bigint>,
  testConfig: TestConfig,
): Promise<Map<string, bigint>> {
  const events = await api.query.system.events()
  const extractor = testConfig.feeExtractor ?? standardFeeExtractor
  const feeInfos = extractor(events as unknown as EventRecord[], api)

  for (const { who, actualFee, tip } of feeInfos) {
    const address = encodeAddress(who, testConfig.addressEncoding)
    const totalFee = actualFee + tip
    const currentFee = feeMap.get(address) || 0n
    feeMap.set(address, currentFee + totalFee)
  }
  return feeMap
}

/// Test configuration related types and functions

/**
 * Whether a chain's ED is lower than typical transaction fees or not.
 *
 * An exact comparison is not relevant - this marker only identifies whether transfers at or around the
 * chain's ED can be made without raising `pallet_balances::FundsUnavailable`.
 */
export type ChainED = 'LowEd' | 'Normal'

/**
 * Get the last known block number for a given chain.
 *
 * The block provider might be local or external (e.g. a parachain querying its relay chain).
 *
 * @param api Promise-based RPC wrapper around the endpoint of a Polkadot chain.
 * @returns The last known block number if relay, the relay chain block number the most recent parablock was anchored
 * to if parachain.
 */
export async function getBlockNumber(api: ApiPromise, blockProvider: BlockProvider): Promise<number> {
  return await match(blockProvider)
    .with('Local', async () => (await api.rpc.chain.getHeader()).number.toNumber())
    .with('NonLocal', async () => ((await api.query.parachainSystem.lastRelayChainBlockNumber()) as any).toNumber())
    .exhaustive()
}

/**
 * Get the next block number in which a task can be scheduled.
 */
export async function nextSchedulableBlockNum(api: ApiPromise, blockProvider: BlockProvider): Promise<number> {
  return await match(blockProvider)
    .with('Local', async () => (await api.rpc.chain.getHeader()).number.toNumber() + 1)
    .with('NonLocal', async () => ((await api.query.parachainSystem.lastRelayChainBlockNumber()) as any).toNumber())
    .exhaustive()
}

/**
 * Get the offset at which the calling network's block provider moves, for every block created in that network.
 *
 * To exemplify, this is useful when injecting tasks into the runtime's scheduler agenda, as the key to the
 * agenda may be a non-local block number.
 *
 * What it outputs:
 *
 * * If on a relay chain, the output is 1 i.e. when injecting a task into the scheduler pallet's agenda storage,
 *   every block number is available.
 * * If on a parachain without AB, 1, with the same meaning as above.
 * * If on a parachain with AB, the offset is 2, because `parachainSystem.lastRelayChainBlockNumber` moves with a step
 *   size of 2, and thus, manually scheduled blocks can only be injected every other relay block number. Also applies
 *   to vesting and treasury spend periods.
 *
 * @param blockProvider Whether the call is being scheduled on a relay or parachain.
 * @param asyncBacking Whether async backing is enabled on the parachain.
 * @returns The number of blocks to offset when scheduling tasks
 */
export function blockProviderOffset(cfg: TestConfig): number {
  if (cfg.blockProvider === 'Local') {
    return 1
  }

  if (cfg.asyncBacking === 'Enabled') {
    return 2
  }

  // On a parachain without async backing.
  return 1
}

/**
 * Sort a list of addresses by their byte representation and the address encoding of the chain.
 * The sorted list can then be safely used as a signatories list in multisig calls.
 */
export function sortAddressesByBytes(addresses: string[], addressEncoding: number): string[] {
  return addresses
    .map((addr) => decodeAddress(addr))
    .sort((a, b) => {
      for (let i = 0; ; i++) {
        const overA = i >= a.length
        const overB = i >= b.length
        if (overA && overB) return 0
        else if (overA) return -1
        else if (overB) return 1
        else if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1
      }
    })
    .map((bytes) => encodeAddress(bytes, addressEncoding))
}

/**
 * Get the free funds of an account.
 */
export async function getFreeFunds(client: Client<any, any>, address: any): Promise<number> {
  const account = (await client.api.query.system.account(address)) as FrameSystemAccountInfo
  return account.data.free.toNumber()
}

/**
 * Get the reserved funds of an account.
 */
export async function getReservedFunds(client: Client<any, any>, address: any): Promise<number> {
  const account = (await client.api.query.system.account(address)) as FrameSystemAccountInfo
  return account.data.reserved.toNumber()
}

/**
 * Configuration for relay chain tests.
 */
export interface RelayTestConfig {
  testSuiteName: string
  addressEncoding: number
  blockProvider: 'Local'
  chainEd?: ChainED
  /** Fee extractor for this chain. Defaults to `standardFeeExtractor` when not set. */
  feeExtractor?: FeeExtractor
}

/**
 * Configuration for parachain tests.
 * Async backing is relevant due to the step size of `parachainSystem.lastRelayChainBlockNumber`.
 *
 * Recall that with the AHM, the scheduler pallet's agenda will be keyed by this block number.
 * It is, then, relevant for tests to know whether AB is enabled.
 */
export interface ParaTestConfig {
  testSuiteName: string
  addressEncoding: number
  blockProvider: BlockProvider
  asyncBacking: AsyncBacking
  chainEd?: ChainED
  /** Fee extractor for this chain. Defaults to `standardFeeExtractor` when not set. */
  feeExtractor?: FeeExtractor
}

/**
 * Union type for all test configurations, whether relay or parachain.
 */
export type TestConfig = RelayTestConfig | ParaTestConfig

/**
 * Matcher for an event argument.
 * Can be a literal (compared via `.toString()`) or a function `(actual) => boolean`.
 */
type ArgMatcher = unknown | ((actual: unknown) => boolean)

/**
 * Criteria to match a specific Substrate event.
 * - `type`: event constructor (e.g. `api.events.system.ExtrinsicSuccess`)
 * - `args` (optional): map of argument names to `ArgMatcher`s
 *
 * Examples:
 * { type: api.events.balances.Transfer, args: { from: ALICE, to: BOB } }
 * { type: api.events.scheduler.Dispatched, args: { result: (r) => r.isErr } }
 */
type EventMatchCriteria<T extends AnyTuple = AnyTuple, N = unknown> = {
  type: IsEvent<T, N>
  args?: { [K in keyof N]?: ArgMatcher }
}

/**
 * Assert that specific Substrate events were emitted.
 *
 * Usage:
 * - `type`: the event constructor (e.g. `api.events.system.CodeUpdated`)
 * - `args` (optional): matchers for event fields
 *   - literal: compared via `.toString()`
 *   - function: `(value) => boolean`
 *
 * Examples:
 *
 * // Match by literal
 * assertExpectedEvents(await api.query.system.events(), [
 *   { type: api.events.preimage.Noted, args: { hash_: preimageHash } }
 * ])
 *
 * // Match with function
 * assertExpectedEvents(await api.query.system.events(), [
 *   { type: api.events.scheduler.Dispatched, args: { result: (r) => r.isErr } }
 * ])
 *
 * // Match by type only
 * assertExpectedEvents(await api.query.system.events(), [
 *   { type: api.events.system.CodeUpdated }
 * ])
 */
export function assertExpectedEvents(actualEvents: EventRecord[], expectedEvents: EventMatchCriteria[]): void {
  const missing: string[] = []

  for (const expected of expectedEvents) {
    const { type, args: expectedArgs } = expected

    const match = actualEvents.find(({ event }) => {
      if (!type.is(event)) return false

      if (!expectedArgs) return true

      const namedArgs = (event as IEvent<Codec[]>).data as unknown as Record<string, unknown>

      for (const [key, matcher] of Object.entries(expectedArgs)) {
        const actualValue = namedArgs[key]

        if (typeof matcher === 'function') {
          if (!matcher(actualValue)) {
            return false
          }
        } else {
          if (matcher?.toString?.() !== actualValue?.toString?.()) {
            return false
          }
        }
      }

      return true
    })

    if (!match) {
      const name = type.meta?.name.toString() ?? '[unknown event]'
      const argDesc = expectedArgs
        ? `${JSON.stringify(
            Object.fromEntries(
              Object.entries(expectedArgs).map(([k, v]) => [k, typeof v === 'function' ? '[Function]' : v?.toString()]),
            ),
          )}`
        : ''
      missing.push(`Event type "${name}" with expected args: ${argDesc}`)
    }
  }

  if (missing.length > 0) {
    throw new Error(`Expected events not found:\n- ${missing.join('\n- ')}`)
  }
}

/**
 * Util to build the XCM `MultiLocation` describing the route from one chain to another.
 *
 * Determines how to reach `to` from `from` within a relay–parachain topology:
 * - Relay → Parachain: `{ parents: 0, interior: { X1: [{ Parachain: id }] } }`
 * - Parachain → Relay: `{ parents: 1, interior: "Here" }`
 *
 * @param from - The chain sending the XCM message.
 * @param to - The target chain receiving the XCM message.
 * @returns The computed `MultiLocation` route.
 */
export function getXcmRoute(from: Chain, to: Chain) {
  let parents: number
  let interior: any

  if (from.isRelayChain) {
    parents = 0
  } else {
    parents = 1
  }

  if (to.isRelayChain) {
    interior = 'Here'
  } else {
    interior = { X1: [{ Parachain: to.paraId }] }
  }

  return { parents, interior }
}

/**
 * Test that calls executed via `utility.forceBatch` are filtered or not filtered based on the expected behavior.
 *
 * This helper:
 * 1. Verifies the pallet exists and has calls metadata
 * 2. Executes the `utility.forceBatch` transaction with the provided calls
 * 3. Checks events to verify filtering behavior matches expectations
 *
 * @param client - The API client instance
 * @param palletName - Name of the pallet being tested (e.g., 'Staking', 'Beefy')
 * @param batchCalls - Array of extrinsics to test
 * @param signer - Keyring pair to sign the transaction
 * @param expectedFiltered - 'Filtered' expects all calls to be filtered (CallFiltered error). 'NotFiltered' expects calls not to be filtered.
 */
export async function testCallsViaForceBatch(
  client: Client<any, any>,
  palletName: string,
  batchCalls: any[],
  signer: KeyringPair,
  expectedFiltered: 'Filtered' | 'NotFiltered',
): Promise<void> {
  // Verify the pallet exists and has calls metadata
  const palletMeta = client.api.registry.metadata.pallets.find((pallet) => pallet.name.toString() === palletName)
  expect(palletMeta).toBeDefined()
  expect(palletMeta?.calls).toBeDefined()
  expect((client.api.tx as any)[palletName.charAt(0).toLowerCase() + palletName.slice(1)]).toBeDefined()

  // Execute the `utility.forceBatch` transaction
  const forceBatchTx = client.api.tx.utility.forceBatch(batchCalls)
  await sendTransaction(forceBatchTx.signAsync(signer))
  await client.dev.newBlock()

  // Check events
  const events = await client.api.query.system.events()

  const itemFailedEvents = events.filter((record) => {
    const { event } = record
    return event.section === 'utility' && event.method === 'ItemFailed'
  })

  if (expectedFiltered === 'Filtered') {
    // Should have one `ItemFailed` event per call
    expect(itemFailedEvents.length).toBe(batchCalls.length)

    // Verify each failure was due to `CallFiltered`
    for (const record of itemFailedEvents) {
      assert(client.api.events.utility.ItemFailed.is(record.event))
      const dispatchError = record.event.data.error

      assert(dispatchError.isModule, 'Expected module error')
      expect(client.api.errors.system.CallFiltered.is(dispatchError.asModule)).toBe(true)
    }
  } else {
    // Verify that none of the failures were due to `CallFiltered`
    for (const record of itemFailedEvents) {
      assert(client.api.events.utility.ItemFailed.is(record.event))
      const dispatchError = record.event.data.error

      if (dispatchError.isModule) {
        // If it's a module error, check that it's NOT CallFiltered
        expect(client.api.errors.system.CallFiltered.is(dispatchError.asModule)).toBe(false)
      }
    }
  }
}
