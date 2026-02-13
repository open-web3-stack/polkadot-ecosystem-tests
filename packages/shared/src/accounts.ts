import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, testAccounts } from '@e2e-test/networks'
import { type Client, type RootTestTree, setupNetworks } from '@e2e-test/shared'

import type { SubmittableExtrinsic } from '@polkadot/api/types'
import type { KeyringPair } from '@polkadot/keyring/types'
import type { Vec } from '@polkadot/types'
import type { FrameSystemEventRecord } from '@polkadot/types/lookup'
import type { ISubmittableResult } from '@polkadot/types/types'
import { encodeAddress } from '@polkadot/util-crypto'

import { assert, expect } from 'vitest'

import { match } from 'ts-pattern'
import {
  blockProviderOffset,
  check,
  checkEvents,
  checkSystemEvents,
  createXcmTransactSend,
  findFeeEvent,
  getBlockNumber,
  scheduleInlineCallWithOrigin,
  type TestConfig,
  updateCumulativeFees,
} from './helpers/index.js'

//
// Note about this module
//
// Tests are grouped by the main extrinsic from the balances pallet that they target; both the source code,
// and the test trees used to register test cases with `vitest`.
//
// Some tests have different behavior based on the chain's ED; this is check through the test configuration.
// This is because some operations, like the intentional reaping of an account through `transfer_allow_death`, must
// be executed with a different amount of funds depending on the ED ~ tx. fee relationship.
//
// This is currently not done in favor of skipping those tests in low ED chains; it is left for a future PR.

/// -------
/// Helpers
/// -------

/**
 * Create a fresh account with specific balance above existential deposit
 */
async function createAccountWithBalance<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(client: Client<TCustom, TInitStorages>, balance: any, seed: string): Promise<KeyringPair> {
  // Create fresh account from seed
  const newAccount = testAccounts.keyring.createFromUri(`${seed}`)

  // Set account balance directly via storage
  await client.dev.setStorage({
    System: {
      account: [[[newAccount.address], { providers: 1, data: { free: balance } }]],
    },
  })

  return newAccount
}

/**
 * Given a client, query if an account has been reaped (removed from storage).
 *
 * @returns a promise that resolves to true if the account has been reaped, false otherwise.
 */
async function isAccountReaped(client: Client<any, any>, address: string): Promise<boolean> {
  const account = await client.api.query.system.account(address)
  // An account is reaped (or never existed) if it has no nonce, no providers, and zero balance.
  return (
    account.consumers.toNumber() === 0 &&
    account.providers.toNumber() === 0 &&
    account.sufficients.toNumber() === 0 &&
    account.data.free.toBigInt() === 0n &&
    account.data.frozen.toBigInt() === 0n &&
    account.data.reserved.toBigInt() === 0n
  )
}

/**
 * Find a transfer event between two specific accounts in a list of events.
 *
 * @param events - Array of event records to search through
 * @param client - The client instance for type checking
 * @param fromAddress - The sender address (raw address, not encoded)
 * @param toAddress - The recipient address (raw address, not encoded)
 * @param addressEncoding - The address encoding to use for comparison
 * @returns The transfer event record if found, undefined otherwise
 */
function findTransferEvent<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(
  events: Vec<FrameSystemEventRecord>,
  client: Client<TCustom, TInitStorages>,
  fromAddress: string,
  toAddress: string,
  addressEncoding: number,
): FrameSystemEventRecord | undefined {
  return events.find((record) => {
    const { event } = record
    if (event.section === 'balances' && event.method === 'Transfer') {
      assert(client.api.events.balances.Transfer.is(event))
      return (
        event.data.from.toString() === encodeAddress(fromAddress, addressEncoding) &&
        event.data.to.toString() === encodeAddress(toAddress, addressEncoding)
      )
    }
    return false
  })
}

/**
 * Interface for actions that create reserved/held funds.
 *
 * Examples: bonding funds for staking, nomination pool creation or joining.
 */
interface ReserveAction<
  TCustom extends Record<string, unknown>,
  TInitStorages extends Record<string, Record<string, any>>,
> {
  /** Name of the action - will be used to tag the test and its snapshots. */
  name: string
  /**
   * When awaited, this action will created the desired reserve in the calling account.
   *
   * @returns The amount of the reserve created. This is necessary because some actions may created a reserve
   * that is not the same as the amount passed to them, which will cause later checks to fail.
   * */
  execute: (client: Client<TCustom, TInitStorages>, alice: KeyringPair, amount: bigint) => Promise<bigint>
  /** Whether this action is available on the given network. If not, the test will be skipped. */
  isAvailable: (client: Client<TCustom, TInitStorages>) => boolean
}

/**
 * Interface for actions that create locks/freezes on funds.
 *
 * Examples: vested transfer, conviction voting.
 */
export interface LockAction<
  TCustom extends Record<string, unknown>,
  TInitStorages extends Record<string, Record<string, any>>,
> {
  /** Name of the action - will be used to tag the test and its snapshots. */
  name: string
  /** When awaited, this action will create the desired lock in the calling account. */
  execute: (
    client: Client<TCustom, TInitStorages>,
    alice: KeyringPair,
    amount: bigint,
    testConfig: TestConfig,
  ) => Promise<void>
  /** Whether this action is available on the given network. If not, the test will be skipped. */
  isAvailable: (client: Client<TCustom, TInitStorages>) => boolean
}

/**
 * Interface for deposit-requiring actions that can be tested for liquidity restrictions.
 */
interface DepositAction<
  TCustom extends Record<string, unknown>,
  TInitStorages extends Record<string, Record<string, any>>,
> {
  /** Name of the action - will be used to tag the test and its snapshots. */
  name: string
  /**
   * When awaited, this action will attempt to create the desired reserve in the calling account.
   *
   * To trigger the expected error, this must be an extrinsic from a pallet that still uses the old `Currency` traits,
   * in particular `Currency::reserve`.
   * */
  createTransaction: (client: Client<TCustom, TInitStorages>) => Promise<any>
  /**
   * When awaited, this action will calculate the deposit required to create the desired reserve.
   *
   * This differs based on the action - proxy deposits have a base and a factor (applied per proxy creation), as do
   * multisig creation deposits, but referenda submissions have a fixed deposit.
   *
   * This method calculates the deposit for the given action, for use in later checks that the action failed, but
   * should have succeeded based on available funds.
   *
   * @returns The amount required to create the desired reserve on funds.
   */
  calculateDeposit: (client: Client<TCustom, TInitStorages>) => Promise<bigint>
  /** Whether this action is available on the given network. If not, the test will be skipped. */
  isAvailable: (client: Client<TCustom, TInitStorages>) => boolean
}

// Reserve Actions

export const stakingReserveAction = <
  TCustom extends Record<string, unknown>,
  TInitStorages extends Record<string, Record<string, any>>,
>(): ReserveAction<TCustom, TInitStorages> => ({
  name: 'staking bond',
  execute: async (client: Client<TCustom, TInitStorages>, alice: KeyringPair, amount: bigint): Promise<bigint> => {
    const bondTx = client.api.tx.staking.bond(amount, { Staked: null })
    await sendTransaction(bondTx.signAsync(alice))
    // Note: Don't call newBlock() here - let the caller handle it so fees can be tracked
    return amount
  },
  isAvailable: (client: Client<TCustom, TInitStorages>) => !!client.api.tx.staking,
})

export const nominationPoolReserveAction = <
  TCustom extends Record<string, unknown>,
  TInitStorages extends Record<string, Record<string, any>>,
>(): ReserveAction<TCustom, TInitStorages> => ({
  name: 'nomination pool',
  execute: async (client: Client<TCustom, TInitStorages>, alice: KeyringPair, amount: bigint): Promise<bigint> => {
    const aliceNonce = (await client.api.rpc.system.accountNextIndex(alice.address)).toNumber()
    const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
    // See `nomination_pools::do_create`, but TL;DR is that the total amount reserved from an account
    // that creates a nomination poolis the amount passed to `create` plus the existential deposit.
    // Thus, here 1 ED is subtracted so that the tests' checks are the same for all actions.
    const virtualAmount = amount - existentialDeposit
    const createPoolTx = client.api.tx.nominationPools.create(
      virtualAmount,
      alice.address,
      alice.address,
      alice.address,
    )
    await sendTransaction(createPoolTx.signAsync(alice, { nonce: aliceNonce }))
    return virtualAmount
  },
  isAvailable: (client: Client<TCustom, TInitStorages>) => !!client.api.tx.nominationPools,
})

export const manualReserveAction = <
  TCustom extends Record<string, unknown>,
  TInitStorages extends Record<string, Record<string, any>>,
>(): ReserveAction<TCustom, TInitStorages> => ({
  name: 'manual reserve',
  execute: async (client: Client<TCustom, TInitStorages>, alice: KeyringPair, amount: bigint): Promise<bigint> => {
    // Get current account state
    const currentAccount = await client.api.query.system.account(alice.address)
    const currentFree = currentAccount.data.free.toBigInt()
    const currentFrozen = currentAccount.data.frozen.toBigInt()
    const aliceNonce = (await client.api.rpc.system.accountNextIndex(alice.address)).toNumber()

    // Manually set reserved amount and reduce free balance
    await client.dev.setStorage({
      System: {
        account: [
          [
            [alice.address],
            {
              nonce: aliceNonce,
              consumers: 1 + currentAccount.consumers.toNumber(),
              sufficients: currentAccount.sufficients.toNumber(),
              providers: currentAccount.providers.toNumber(),
              data: {
                free: currentFree - amount,
                reserved: amount,
                frozen: currentFrozen,
                flags: currentAccount.data.flags,
              },
            },
          ],
        ],
      },
    })
    return amount
  },
  isAvailable: () => true, // Always available
})

/**
 * Create default reserve actions to be used in the liquidity restriction tests.
 *
 * Recall that if a network does not support one of these, it'll be skipped when generating the test cases.
 * Networks can still override these by providing custom actions in their config.
 */
export function createDefaultReserveActions<
  TCustom extends Record<string, unknown>,
  TInitStorages extends Record<string, Record<string, any>>,
>(): ReserveAction<TCustom, TInitStorages>[] {
  return [
    stakingReserveAction<TCustom, TInitStorages>(),
    nominationPoolReserveAction<TCustom, TInitStorages>(),
    manualReserveAction<TCustom, TInitStorages>(),
  ]
}

// Lock Actions

export const vestedTransferLockAction = <
  TCustom extends Record<string, unknown>,
  TInitStorages extends Record<string, Record<string, any>>,
>(): LockAction<TCustom, TInitStorages> => ({
  name: 'vested transfer',
  execute: async (
    client: Client<TCustom, TInitStorages>,
    alice: KeyringPair,
    amount: bigint,
    testConfig: TestConfig,
  ): Promise<void> => {
    const offset = blockProviderOffset(testConfig)
    const number = await getBlockNumber(client.api, testConfig.blockProvider)
    const perBlock = client.api.consts.balances.existentialDeposit.toBigInt()
    const startingBlock = BigInt(number) + 3n * BigInt(offset)

    const vestedTransferTx = client.api.tx.vesting.vestedTransfer(alice.address, {
      locked: amount,
      perBlock: perBlock,
      startingBlock: startingBlock,
    })
    await sendTransaction(vestedTransferTx.signAsync(alice))
  },
  isAvailable: (client: Client<TCustom, TInitStorages>) => !!client.api.tx.vesting,
})

export const manualLockAction = <
  TCustom extends Record<string, unknown>,
  TInitStorages extends Record<string, Record<string, any>>,
>(): LockAction<TCustom, TInitStorages> => ({
  name: 'manual lock',
  execute: async (client: Client<TCustom, TInitStorages>, alice: KeyringPair, amount: bigint): Promise<void> => {
    // Get current account state
    const currentAccount = await client.api.query.system.account(alice.address)
    const currentFree = currentAccount.data.free.toBigInt()
    const currentReserved = currentAccount.data.reserved.toBigInt()
    const aliceNonce = (await client.api.rpc.system.accountNextIndex(alice.address)).toNumber()

    // Manually set frozen amount, and don't modify free balance as frozen constraint works on the total
    await client.dev.setStorage({
      System: {
        account: [
          [
            [alice.address],
            {
              nonce: aliceNonce,
              consumers: 1 + currentAccount.consumers.toNumber(),
              providers: currentAccount.providers.toNumber(),
              sufficients: currentAccount.sufficients.toNumber(),
              data: {
                free: currentFree,
                reserved: currentReserved,
                frozen: amount,
                flags: currentAccount.data.flags,
              },
            },
          ],
        ],
      },
    })
  },
  isAvailable: () => true, // Always available
})

/**
 * Define the lock actions to be used in the liquidity restriction tests.
 *
 * Recall that in the case a network does not support one of these, it'll be skipped when generating the test cases.
 */
export function createDefaultLockActions<
  TCustom extends Record<string, unknown>,
  TInitStorages extends Record<string, Record<string, any>>,
>(): LockAction<TCustom, TInitStorages>[] {
  return [vestedTransferLockAction<TCustom, TInitStorages>(), manualLockAction<TCustom, TInitStorages>()]
}

// Deposit Actions

export const proxyAdditionDepositAction = <
  TCustom extends Record<string, unknown>,
  TInitStorages extends Record<string, Record<string, any>>,
>(): DepositAction<TCustom, TInitStorages> => ({
  name: 'proxy addition',
  createTransaction: async (client: Client<TCustom, TInitStorages>) => {
    const bob = testAccounts.bob
    return client.api.tx.proxy.addProxy(bob.address, 'Any', 0)
  },
  calculateDeposit: async (client: Client<TCustom, TInitStorages>) => {
    const proxyDepositFactor = client.api.consts.proxy.proxyDepositFactor.toBigInt()
    const proxyDepositBase = client.api.consts.proxy.proxyDepositBase.toBigInt()
    return proxyDepositFactor * 1n + proxyDepositBase
  },
  isAvailable: (client: Client<TCustom, TInitStorages>) => !!client.api.tx.proxy,
})

export const multisigCreationDepositAction = <
  TCustom extends Record<string, unknown>,
  TInitStorages extends Record<string, Record<string, any>>,
>(): DepositAction<TCustom, TInitStorages> => ({
  name: 'multisig creation',
  createTransaction: async (client: Client<TCustom, TInitStorages>) => {
    const bob = testAccounts.bob
    const call = client.api.tx.system.remark('multisig test')
    return client.api.tx.multisig.asMulti(2, [bob.address], null, call, { refTime: 1000000, proofSize: 1000 })
  },
  calculateDeposit: async (client: Client<TCustom, TInitStorages>) => {
    const depositBase = client.api.consts.multisig.depositBase.toBigInt()
    const depositFactor = client.api.consts.multisig.depositFactor.toBigInt()
    return depositBase + depositFactor * 2n
  },
  isAvailable: (client: Client<TCustom, TInitStorages>) => !!client.api.tx.multisig,
})

export const referendumSubmissionDepositAction = <
  TCustom extends Record<string, unknown>,
  TInitStorages extends Record<string, Record<string, any>>,
>(): DepositAction<TCustom, TInitStorages> => ({
  name: 'referendum submission',
  createTransaction: async (client: Client<TCustom, TInitStorages>) => {
    return client.api.tx.referenda.submit(
      { System: 'Root' } as any,
      { Inline: client.api.tx.system.remark('test referendum').method.toHex() },
      { After: 1 },
    )
  },
  calculateDeposit: async (client: Client<TCustom, TInitStorages>) => {
    return client.api.consts.referenda.submissionDeposit.toBigInt()
  },
  isAvailable: (client: Client<TCustom, TInitStorages>) => !!client.api.tx.referenda,
})

/**
 * Define the deposit-requiring actions that will trigger the liquidity restriction error.
 *
 * Recall that if a network does not support one of these, it'll be skipped when generating the test cases.
 *
 * On almost every network, proxy and/or multisig are available, so the test is guaranteed to run
 * at least once each network.
 *
 * Even still, networks can override these action by providing custom actions in their config.
 */
export function createDefaultDepositActions<
  TCustom extends Record<string, unknown>,
  TInitStorages extends Record<string, Record<string, any>>,
>(): DepositAction<TCustom, TInitStorages>[] {
  return [
    proxyAdditionDepositAction<TCustom, TInitStorages>(),
    multisigCreationDepositAction<TCustom, TInitStorages>(),
    referendumSubmissionDepositAction<TCustom, TInitStorages>(),
  ]
}

/**
 * Test that a transfer function fails when sender has insufficient funds.
 *
 * 1. Create a fresh account with some balance
 * 2. Attempt to transfer more than the account has available
 * 3. Verify that the transaction fails
 * 4. Check that no transfer occurred and only fees were deducted
 */
async function transferInsufficientFundsTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(
  chain: Chain<TCustom, TInitStorages>,
  testConfig: TestConfig,
  transferFn: (
    client: Client<TCustom, TInitStorages>,
    bob: string,
    ...args: any[]
  ) => SubmittableExtrinsic<'promise', ISubmittableResult>,
) {
  const [client] = await setupNetworks(chain)

  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const totalBalance = existentialDeposit * 100n
  const alice = await createAccountWithBalance(client, totalBalance, '//fresh_alice')
  const bob = testAccounts.keyring.createFromUri('//fresh_bob')

  expect(await isAccountReaped(client, alice.address)).toBe(false)
  expect(await isAccountReaped(client, bob.address)).toBe(true)

  // Try to transfer more than Alice has (200 ED when she only has 100 ED)
  const transferAmount = 2n * totalBalance
  const transferTx = transferFn(client, bob.address, transferAmount)
  await sendTransaction(transferTx.signAsync(alice))

  await client.dev.newBlock()

  // Check that transaction failed with FundsUnavailable error
  const events = await client.api.query.system.events()
  const failedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  expect(failedEvent).toBeDefined()
  assert(client.api.events.system.ExtrinsicFailed.is(failedEvent!.event))
  const dispatchError = failedEvent!.event.data.dispatchError

  // Check that it's the FundsUnavailable token error
  assert(dispatchError.isToken)
  const tokenError = dispatchError.asToken
  assert(tokenError.isFundsUnavailable)

  // Verify no transfer occurred - Alice still has funds, Bob still unalive
  expect(await isAccountReaped(client, alice.address)).toBe(false)
  expect(await isAccountReaped(client, bob.address)).toBe(true)

  // Get the transaction fee from the payment event
  const feeInfo = findFeeEvent(events, client.api, testConfig)
  assert(feeInfo, 'expected a TransactionFeePaid event')
  assert(feeInfo.tip === 0n, 'unexpected extrinsic tip')
  expect(feeInfo.actualFee).toBeGreaterThan(0n)

  // Verify Alice's balance only decreased by the transaction fee
  const aliceAccount = await client.api.query.system.account(alice.address)
  expect(aliceAccount.data.free.toBigInt()).toBe(totalBalance - feeInfo.actualFee)
}

/**
 * Expectation for the result of a liquidity restriction test.
 * See https://github.com/open-web3-stack/polkadot-ecosystem-tests/issues/417.
 *
 * - If `success`, the running chain's runtime has been updated to include a fix to the
 *   `balances.LiquidityRestrictions` error some actions were incorrectly raising.
 *   Liqudity restriction tests should thus pass.
 * - If `failure`, the running chain's runtime has not been updated yet, and the tests should expect
 *   the reserve-creating action they're using to fail.
 */
export type LiqRestrTestResExpectation = 'failure' | 'success'

export interface AccountsTestConfig<
  TCustom extends Record<string, unknown>,
  TInitStoragesBase extends Record<string, Record<string, any>>,
  TInitStoragesRelay extends Record<string, Record<string, any>>,
> {
  /** Expected behavior for liquidity restriction tests */
  expectation: LiqRestrTestResExpectation
  /** Optional relay chain for XCM-based operations */
  relayChain?: Chain<TCustom, TInitStoragesRelay>
  /** Custom action lists - if not provided, defaults will be used */
  actions?: {
    reserveActions: ReserveAction<TCustom, TInitStoragesBase>[]
    lockActions: LockAction<TCustom, TInitStoragesBase>[]
    depositActions: DepositAction<TCustom, TInitStoragesBase>[]
  }
}

/**
 * Create accounts test configuration, with optional overrides for each of field.
 * If none are provided, the default configuration is returned.
 */
export function createAccountsConfig<
  TCustom extends Record<string, unknown>,
  TInitStoragesBase extends Record<string, Record<string, any>>,
  TInitStoragesRelay extends Record<string, Record<string, any>>,
>(
  overrides?: Partial<AccountsTestConfig<TCustom, TInitStoragesBase, TInitStoragesRelay>>,
): AccountsTestConfig<TCustom, TInitStoragesBase, TInitStoragesRelay> {
  return {
    ...defaultAccountsTestConfig<TCustom, TInitStoragesBase, TInitStoragesRelay>(),
    ...overrides,
  }
}

/**
 * Default accounts E2E test configuration.
 *
 * 1. Liquidity restriction tests are expected to fail
 * 2. The relay chain field is empty, meaning the chain has the `scheduler` pallet available
 * 3. The action lists used in liq. restriction tests are all defaults
 */
const defaultAccountsTestConfig = <
  TCustom extends Record<string, unknown>,
  TInitStoragesBase extends Record<string, Record<string, any>>,
  TInitStoragesRelay extends Record<string, Record<string, any>>,
>(): AccountsTestConfig<TCustom, TInitStoragesBase, TInitStoragesRelay> => ({
  expectation: 'failure',
  actions: {
    reserveActions: createDefaultReserveActions(),
    lockActions: createDefaultLockActions(),
    depositActions: createDefaultDepositActions(),
  },
})

/// -----
/// Tests
/// -----

// ----------------------
// `transfer_allow_death`
// ----------------------

/**
 * Test that `transfer_allow_death` allows the killing of the sender account.
 *
 * 1. Create a fresh account with balance above existential deposit
 * 2. Create a fresh account with balance equal to existential deposit
 * 3. Transfer all balance away from the first account to the second account
 * 4. Verify that the first account has been reaped
 * 5. Check that events emitted as a result of this operation contain correct data
 */
async function transferAllowDeathTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  // Create fresh accounts
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const eps = existentialDeposit / 2n
  // When transferring this amount, net of fees, the account should have less than 1 ED remaining.
  const totalBalance = existentialDeposit + eps
  const alice = await createAccountWithBalance(client, totalBalance, '//fresh_alice')
  const bob = testAccounts.keyring.createFromUri('//fresh_bob')

  // Verify both accounts have empty data before transfer
  expect(await isAccountReaped(client, alice.address)).toBe(false)
  expect(await isAccountReaped(client, bob.address)).toBe(true)

  const transferTx = client.api.tx.balances.transferAllowDeath(bob.address, existentialDeposit)

  const transferEvents = await sendTransaction(transferTx.signAsync(alice))

  await client.dev.newBlock()

  await checkEvents(
    transferEvents,
    // Event of fee withdrawal from Alice
    { section: 'balances', method: 'Withdraw' },
    // Alice account is reaped, so dust is lost
    { section: 'balances', method: 'DustLost' },
  )
    // Withdrawal and dust lost events may change due to fees
    .redact({ number: 0 })
    .toMatchSnapshot('unstable events when Alice `transfer_allow_death` to Bob')

  // `Deposit` events are irrelevant, as they contain data that may change as `chopsticks` selects different block
  // producers each test run, causing the snapshot to fail.
  await checkEvents(
    transferEvents,
    // Bob's account was fundless, and its endowment emits an event
    { section: 'balances', method: 'Endowed' },
    { section: 'system', method: 'KilledAccount' },
    { section: 'system', method: 'NewAccount' },
  ).toMatchSnapshot('events when Alice `transfer_allow_death` to Bob')

  // Verify only Alice's account was reaped
  expect(await isAccountReaped(client, alice.address)).toBe(true)
  expect(await isAccountReaped(client, bob.address)).toBe(false)

  const bobAccount = await client.api.query.system.account(bob.address)
  expect(bobAccount.data.free.toBigInt()).toBe(existentialDeposit)

  // Check the events snapshot above:
  // 1. `Transfer` event
  // 2. `Withdraw` event
  // 3. `DustLost` event
  // 4. `Endowed` event
  // 5. `KilledAccount` event
  // 6. `NewAccount` event

  const events = await client.api.query.system.events()

  // Transaction payment event that should appear before any other events; other events are regular
  const feeInfo = findFeeEvent(events, client.api, testConfig)
  assert(feeInfo, 'expected a TransactionFeePaid event')
  assert(feeInfo.tip === 0n, 'unexpected extrinsic tip')

  // Check `Transfer` event
  const transferEvent = findTransferEvent(events, client, alice.address, bob.address, testConfig.addressEncoding)
  expect(transferEvent).toBeDefined()
  assert(client.api.events.balances.Transfer.is(transferEvent!.event))
  const transferEventData = transferEvent!.event.data
  expect(transferEventData.from.toString()).toBe(encodeAddress(alice.address, testConfig.addressEncoding))
  expect(transferEventData.to.toString()).toBe(encodeAddress(bob.address, testConfig.addressEncoding))
  expect(transferEventData.amount.toBigInt()).toBe(existentialDeposit)

  // Check `Withdraw` event
  const withdrawEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'Withdraw'
  })
  expect(withdrawEvent).toBeDefined()
  assert(client.api.events.balances.Withdraw.is(withdrawEvent!.event))
  const withdrawEventData = withdrawEvent!.event.data
  expect(withdrawEventData.who.toString()).toBe(encodeAddress(alice.address, testConfig.addressEncoding))
  expect(withdrawEventData.amount.toBigInt()).toBe(feeInfo.actualFee)

  // Check `DustLost` event
  const dustLostEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'DustLost'
  })
  expect(dustLostEvent).toBeDefined()
  assert(client.api.events.balances.DustLost.is(dustLostEvent!.event))
  const dustLostEventData = dustLostEvent!.event.data
  expect(dustLostEventData.account.toString()).toBe(encodeAddress(alice.address, testConfig.addressEncoding))
  expect(dustLostEventData.amount.toBigInt()).toBeGreaterThan(0n)
  expect(dustLostEventData.amount.toBigInt()).toBeLessThan(eps)

  // The fee paid by Alice and the dust lost, along with the amount transferred to Bob,
  // should sum to Alice's initial balance.
  expect(existentialDeposit + withdrawEventData.amount.toBigInt() + dustLostEventData.amount.toBigInt()).toBe(
    totalBalance,
  )

  // Check `Endowed` event
  const endowedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'Endowed'
  })
  expect(endowedEvent).toBeDefined()
  assert(client.api.events.balances.Endowed.is(endowedEvent!.event))
  const endowedEventData = endowedEvent!.event.data
  expect(endowedEventData.account.toString()).toBe(encodeAddress(bob.address, testConfig.addressEncoding))
  expect(endowedEventData.freeBalance.toBigInt()).toBe(existentialDeposit)

  // Check `KilledAccount` event
  const killedAccountEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'KilledAccount'
  })
  expect(killedAccountEvent).toBeDefined()
  assert(client.api.events.system.KilledAccount.is(killedAccountEvent!.event))
  const killedAccountEventData = killedAccountEvent!.event.data
  expect(killedAccountEventData.account.toString()).toBe(encodeAddress(alice.address, testConfig.addressEncoding))

  // Check `NewAccount` event
  const newAccountEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'NewAccount'
  })
  expect(newAccountEvent).toBeDefined()
  assert(client.api.events.system.NewAccount.is(newAccountEvent!.event))
  const newAccountEventData = newAccountEvent!.event.data
  expect(newAccountEventData.account.toString()).toBe(encodeAddress(bob.address, testConfig.addressEncoding))
}

/**
 * Test that `transfer_allow_death` with sufficient balance preserves the sender account.
 *
 * 1. Create a fresh account with high balance
 * 2. Transfer a small amount to another account
 * 3. Verify that the sender account is not reaped
 * 4. Check events and post-transfer account data
 */
async function transferAllowDeathNoKillTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  // Create fresh accounts
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const totalBalance = existentialDeposit * 100n // 100 ED
  const alice = await createAccountWithBalance(client, totalBalance, '//fresh_alice')
  const bob = testAccounts.keyring.createFromUri('//fresh_bob')

  // Verify initial state
  expect(await isAccountReaped(client, alice.address)).toBe(false)
  expect(await isAccountReaped(client, bob.address)).toBe(true)

  const transferAmount = existentialDeposit // 1 ED
  const transferTx = client.api.tx.balances.transferAllowDeath(bob.address, transferAmount)
  const transferEvents = await sendTransaction(transferTx.signAsync(alice))

  await client.dev.newBlock()

  // Snapshot some events
  await checkEvents(
    transferEvents,
    // Bob's account was fundless, and its endowment emits an event
    { section: 'balances', method: 'Endowed' },
    { section: 'system', method: 'NewAccount' },
  ).toMatchSnapshot('events when Alice transfers 1 ED to Bob with sufficient balance')

  // Verify Alice's account was NOT reaped
  expect(await isAccountReaped(client, alice.address)).toBe(false)
  expect(await isAccountReaped(client, bob.address)).toBe(false)

  // Check final balances
  const aliceAccount = await client.api.query.system.account(alice.address)
  const bobAccount = await client.api.query.system.account(bob.address)

  // Get the extrinsic's fee
  const events = await client.api.query.system.events()
  const feeInfo = findFeeEvent(events, client.api, testConfig)
  assert(feeInfo, 'expected a TransactionFeePaid event')
  assert(feeInfo.tip === 0n, 'unexpected extrinsic tip')
  expect(feeInfo.actualFee).toBeGreaterThan(0n)

  expect(bobAccount.data.free.toBigInt()).toBe(transferAmount)
  // Alice should have her original balance minus the transfer amount minus fees
  expect(aliceAccount.data.free.toBigInt()).toBe(totalBalance - transferAmount - feeInfo.actualFee)

  // Check events - verify NO KilledAccount events are present
  const killedAccountEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'KilledAccount'
  })
  expect(killedAccountEvent).toBeUndefined()

  // Verify transfer event -- fee transfers also count, so a filter for the proper sender is needed.
  const transferEvent = findTransferEvent(events, client, alice.address, bob.address, testConfig.addressEncoding)
  expect(transferEvent).toBeDefined()
  assert(client.api.events.balances.Transfer.is(transferEvent!.event))
  const transferEventData = transferEvent!.event.data
  expect(transferEventData.from.toString()).toBe(encodeAddress(alice.address, testConfig.addressEncoding))
  expect(transferEventData.to.toString()).toBe(encodeAddress(bob.address, testConfig.addressEncoding))
  expect(transferEventData.amount.toBigInt()).toBe(transferAmount)

  // Verify withdraw event
  const withdrawEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'Withdraw'
  })
  expect(withdrawEvent).toBeDefined()
  assert(client.api.events.balances.Withdraw.is(withdrawEvent!.event))
  const withdrawEventData = withdrawEvent!.event.data
  expect(withdrawEventData.who.toString()).toBe(encodeAddress(alice.address, testConfig.addressEncoding))
  expect(withdrawEventData.amount.toBigInt()).toBe(feeInfo.actualFee)

  // Verify endowment event
  const endowedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'Endowed'
  })
  expect(endowedEvent).toBeDefined()
  assert(client.api.events.balances.Endowed.is(endowedEvent!.event))
  const endowedEventData = endowedEvent!.event.data
  expect(endowedEventData.account.toString()).toBe(encodeAddress(bob.address, testConfig.addressEncoding))
  expect(endowedEventData.freeBalance.toBigInt()).toBe(transferAmount)

  // Verify `NewAccount` event
  const newAccountEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'NewAccount'
  })
  expect(newAccountEvent).toBeDefined()
}

/**
 * Test that `transfer_allow_death` fails when transferring below existential deposit.
 *
 * 1. Create a fresh account with high balance
 * 2. Attempt to transfer an amount below ED to another account
 * 3. Verify that the transaction fails
 * 4. Check that no funds were transferred, only fees deducted
 */
async function transferBelowExistentialDepositTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  // Create fresh accounts
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const aliceBalance = existentialDeposit * 100n // 100 ED
  const alice = await createAccountWithBalance(client, aliceBalance, '//fresh_alice')
  const bob = testAccounts.keyring.createFromUri('//fresh_bob')

  // Verify initial state
  expect(await isAccountReaped(client, alice.address)).toBe(false)
  expect(await isAccountReaped(client, bob.address)).toBe(true)

  const transferAmount = existentialDeposit - 1n
  const transferTx = client.api.tx.balances.transferAllowDeath(bob.address, transferAmount)
  await sendTransaction(transferTx.signAsync(alice))

  await client.dev.newBlock()

  // Check that transaction failed with ExistentialDeposit error
  const events = await client.api.query.system.events()
  const failedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  expect(failedEvent).toBeDefined()
  assert(client.api.events.system.ExtrinsicFailed.is(failedEvent!.event))
  const dispatchError = failedEvent!.event.data.dispatchError

  // Check that it's the ExistentialDeposit error from balances pallet
  assert(dispatchError.isToken)
  const tokenError = dispatchError.asToken
  assert(tokenError.isBelowMinimum)

  // Verify no transfer occurred - Alice still has original balance, Bob still reaped
  expect(await isAccountReaped(client, alice.address)).toBe(false)
  expect(await isAccountReaped(client, bob.address)).toBe(true)

  // Get the transaction fee from the payment event
  const feeInfo = findFeeEvent(events, client.api, testConfig)
  assert(feeInfo, 'expected a TransactionFeePaid event')
  assert(feeInfo.tip === 0n, 'unexpected extrinsic tip')
  expect(feeInfo.actualFee).toBeGreaterThan(0n)

  // Verify Alice's balance only decreased by the transaction fee
  const aliceAccount = await client.api.query.system.account(alice.address)
  expect(aliceAccount.data.free.toBigInt()).toBe(aliceBalance - feeInfo.actualFee)
}

/**
 * Insufficient funds checks for `transfer_allow_death`
 */
async function transferAllowDeathInsufficientFundsTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const lambda = (client: Client<TCustom, TInitStorages>, bob: string, amt: bigint) =>
    client.api.tx.balances.transferAllowDeath(bob, amt)

  await transferInsufficientFundsTest(chain, testConfig, lambda)
}

/**
 * Test that `transfer_allow_death` with reserve does not kill the sender account.
 *
 * 1. Create a fresh account with 10+eps ED of balance
 * 2. Create a reserve on the account for 2 ED, increasing consumer count
 * 3. Transfer 8 ED to another account
 * 4. Verify that the transfer didn't occur, and thus the first account was NOT reaped due to the consumer ref
 * 5. Check that events emitted as a result of this operation contain correct data
 */
async function transferAllowDeathWithReserveTest<
  TCustom extends Record<string, unknown>,
  TInitStorages extends Record<string, Record<string, any>>,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  // 1. Create fresh addresses, one with 10 ED (plus some extra for fees)
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const eps = existentialDeposit / 2n
  const totalBalance = existentialDeposit * 10n + eps // 10 ED + some extra
  const alice = await createAccountWithBalance(client, totalBalance, '//fresh_alice')
  const bob = testAccounts.keyring.createFromUri('//fresh_bob')

  // Verify both accounts have expected initial state
  expect(await isAccountReaped(client, alice.address)).toBe(false)
  expect(await isAccountReaped(client, bob.address)).toBe(true)

  // Use the manual reserve action
  const reserveAction = manualReserveAction<TCustom, TInitStorages>()

  // 2. Execute reserve action to create a consumer

  const reservedAmount = await reserveAction.execute(client, alice, existentialDeposit * 2n)
  await client.dev.newBlock()

  // Get Alice's account state after reserve
  const aliceAccountAfterReserve = await client.api.query.system.account(alice.address)
  expect(aliceAccountAfterReserve.consumers.toNumber()).toBeGreaterThanOrEqual(1)
  expect(aliceAccountAfterReserve.data.reserved.toBigInt()).toBe(reservedAmount)

  // 3. Transfer 8 ED to Bob

  // Calculate how much free balance Alice has left after reserve and prepare transfer
  const aliceFreeBefore = aliceAccountAfterReserve.data.free.toBigInt()
  const transferAmount = existentialDeposit * 8n // Transfer 8 ED to Bob

  const transferTx = client.api.tx.balances.transferAllowDeath(bob.address, transferAmount)
  const transferEvents = await sendTransaction(transferTx.signAsync(alice))

  await client.dev.newBlock()

  // Snapshot events
  await checkEvents(
    transferEvents,
    // Bob's account was fundless, and its endowment emits an event
    { section: 'balances', method: 'Endowed' },
    { section: 'system', method: 'NewAccount' },
  ).toMatchSnapshot('events when Alice with reserve transfers to Bob')

  // 4. Check the transfer failed

  // Verify Alice's account was NOT reaped due to consumer count
  expect(await isAccountReaped(client, alice.address)).toBe(false)
  expect(await isAccountReaped(client, bob.address)).toBe(true)

  const aliceAccountFinal = await client.api.query.system.account(alice.address)
  const bobAccount = await client.api.query.system.account(bob.address)

  // Get the transaction fee
  const events = await client.api.query.system.events()
  const feeInfo = findFeeEvent(events, client.api, testConfig)
  assert(feeInfo, 'expected a TransactionFeePaid event')
  assert(feeInfo.tip === 0n, 'unexpected extrinsic tip')
  expect(feeInfo.actualFee).toBeGreaterThan(0n)

  // Check final balances
  expect(aliceAccountFinal.data.free.toBigInt()).toBe(aliceFreeBefore - feeInfo.actualFee)
  expect(bobAccount.data.free.toBigInt()).toBe(0n)

  // Alice should still have consumers and reserved balance
  expect(aliceAccountFinal.consumers.toNumber()).toBeGreaterThanOrEqual(1)
  expect(aliceAccountFinal.providers.toNumber()).toBe(aliceAccountAfterReserve.providers.toNumber())
  expect(aliceAccountFinal.data.reserved.toBigInt()).toBe(reservedAmount)

  // 5. Check events

  // Verify NO KilledAccount events are present
  const killedAccountEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'KilledAccount'
  })
  expect(killedAccountEvent).toBeUndefined()

  // Check that no transfer event from Alice to Bob occurred
  const transferEvent = findTransferEvent(events, client, alice.address, bob.address, testConfig.addressEncoding)
  expect(transferEvent).toBeUndefined()

  const errorEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })
  assert(client.api.events.system.ExtrinsicFailed.is(errorEvent!.event))
  const errorEventData = errorEvent!.event.data
  assert(errorEventData.dispatchError.isToken)
  const tokenError = errorEventData.dispatchError.asToken
  expect(tokenError.isFrozen).toBeTruthy()
}

/**
 * Test self-transfer of entire balance with `transfer_allow_death`.
 *
 * 1. Create Alice with 100 ED
 * 2. Alice transfers 99 ED to herself
 * 3. Verify that Alice is not reaped
 * 4. Check events for exact numbers
 */
async function transferAllowDeathSelfTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const aliceBalance = existentialDeposit * 100n
  const alice = await createAccountWithBalance(client, aliceBalance, '//fresh_alice')

  expect(await isAccountReaped(client, alice.address)).toBe(false)

  const transferAmount = existentialDeposit * 99n // Transfer almost everything to self
  const transferTx = client.api.tx.balances.transferAllowDeath(alice.address, transferAmount)
  await sendTransaction(transferTx.signAsync(alice))

  await client.dev.newBlock()

  // Get transaction fee
  const events = await client.api.query.system.events()

  const feeInfo = findFeeEvent(events, client.api, testConfig)
  assert(feeInfo, 'expected a TransactionFeePaid event')
  assert(feeInfo.tip === 0n, 'unexpected extrinsic tip')
  expect(feeInfo.actualFee).toBeGreaterThan(0n)

  // Alice should still be alive and balance only reduced by fees
  expect(await isAccountReaped(client, alice.address)).toBe(false)
  const aliceAccount = await client.api.query.system.account(alice.address)
  expect(aliceAccount.data.free.toBigInt()).toBe(aliceBalance - feeInfo.actualFee)

  // Check no killing/creation related events occurred
  const killedAccountEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'KilledAccount'
  })
  expect(killedAccountEvent).toBeUndefined()

  const newAccountEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'NewAccount'
  })
  expect(newAccountEvent).toBeUndefined()

  const dustLostEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'DustLost'
  })
  expect(dustLostEvent).toBeUndefined()
}

// ----------------
// `force_transfer`
// ----------------

/**
 * Test that `force_transfer` allows the killing of the source account.
 *
 * 1. Create a fresh account with balance above existential deposit
 * 2. Force transfer all balance away from the first account to the second account
 * 3. Verify that the first account has been reaped
 * 4. Check that events emitted as a result of this operation contain correct data
 *
 * NOTE: As is usual for PET tests, to simulate execution by a non-signed origin, the scheduler pallet's agenda is
 * manually modified to include a `balances.force_transfer` call for execution in the next block.
 *
 * If the runtime of the chain running this test does have the scheduler pallet, this test must also be given
 * the chain object of its relay chain, so that XCM can be used to execute a `xcmPallet.send` call with a
 * `Transact` containing `balances.force_transfer`, for execution in the chain being tested.
 */
async function forceTransferKillTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesBase extends Record<string, Record<string, any>> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(
  baseChain: Chain<TCustom, TInitStoragesBase>,
  testConfig: TestConfig,
  relayChain?: Chain<TCustom, TInitStoragesRelay>,
) {
  let relayClient: Client<TCustom, TInitStoragesRelay>
  let baseClient: Client<TCustom, TInitStoragesBase>
  const [bc] = await setupNetworks(baseChain)

  // Check if scheduler pallet is available - if not, a relay client needs to be created for an XCM interaction,
  // and the base client needs to be recreated simultaneously - otherwise, they would be unable tocommunicate.
  const hasScheduler = !!bc.api.tx.scheduler
  if (hasScheduler) {
    baseClient = bc
  } else {
    if (!relayChain) {
      throw new Error('Scheduler pallet not available and no relay chain provided for XCM execution')
    }

    const [rc, bc] = await setupNetworks(relayChain, baseChain)
    relayClient = rc
    baseClient = bc
  }

  // Create fresh account
  const existentialDeposit = baseClient.api.consts.balances.existentialDeposit.toBigInt()
  const eps = existentialDeposit / 2n
  const totalBalance = existentialDeposit + eps
  const alice = await createAccountWithBalance(baseClient, totalBalance, '//fresh_alice')
  const bob = testAccounts.keyring.createFromUri('//fresh_bob')

  // Verify both accounts have expected initial state
  expect(await isAccountReaped(baseClient, alice.address)).toBe(false)
  expect(await isAccountReaped(baseClient, bob.address)).toBe(true)

  const forceTransferTx = baseClient.api.tx.balances.forceTransfer(alice.address, bob.address, existentialDeposit)

  if (hasScheduler) {
    // Use root origin to execute force transfer directly
    await scheduleInlineCallWithOrigin(
      baseClient,
      forceTransferTx.method.toHex(),
      { system: 'Root' },
      testConfig.blockProvider,
    )
    await baseClient.dev.newBlock()
  } else {
    // Query parachain ID
    const parachainInfo = await baseClient.api.query.parachainInfo.parachainId()
    const paraId = (parachainInfo as any).toNumber()

    // Create XCM transact message
    const xcmTx = createXcmTransactSend(
      relayClient!,
      {
        parents: 0,
        interior: {
          X1: [{ Parachain: paraId }],
        },
      },
      forceTransferTx.method.toHex(),
      'Superuser',
    )

    await scheduleInlineCallWithOrigin(relayClient!, xcmTx.method.toHex(), { system: 'Root' }, 'Local')

    // Advance blocks on both chains
    await relayClient!.dev.newBlock()
    await baseClient.dev.newBlock()
  }

  // Verify only Alice's account was reaped
  expect(await isAccountReaped(baseClient, alice.address)).toBe(true)
  expect(await isAccountReaped(baseClient, bob.address)).toBe(false)

  const bobAccount = await baseClient.api.query.system.account(bob.address)
  expect(bobAccount.data.free.toBigInt()).toBe(existentialDeposit)

  // Snapshot events
  await checkSystemEvents(
    baseClient,
    // Do not snapshot `Transfer` event, as it is unstable, and the event checker does not allow filtering.
    { section: 'balances', method: 'DustLost' },
    { section: 'balances', method: 'Endowed' },
    { section: 'system', method: 'KilledAccount' },
    { section: 'system', method: 'NewAccount' },
  )
    .redact({ number: 0 })
    .toMatchSnapshot('events of `force_transfer` from Alice to Bob')

  // Check events:
  // 1. `Transfer` event
  // 2. `DustLost` event
  // 3. `Endowed` event
  // 4. `KilledAccount` event
  // 5. `NewAccount` event
  const events = await baseClient.api.query.system.events()

  // Check `Transfer` event - again, filter to disambiguate fee transfers
  const transferEvent = findTransferEvent(events, baseClient, alice.address, bob.address, testConfig.addressEncoding)
  expect(transferEvent).toBeDefined()
  assert(baseClient.api.events.balances.Transfer.is(transferEvent!.event))
  const transferEventData = transferEvent!.event.data
  expect(transferEventData.from.toString()).toBe(encodeAddress(alice.address, testConfig.addressEncoding))
  expect(transferEventData.to.toString()).toBe(encodeAddress(bob.address, testConfig.addressEncoding))
  expect(transferEventData.amount.toBigInt()).toBe(existentialDeposit)

  // Check `DustLost` event
  const dustLostEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'DustLost'
  })
  expect(dustLostEvent).toBeDefined()
  assert(baseClient.api.events.balances.DustLost.is(dustLostEvent!.event))
  const dustLostEventData = dustLostEvent!.event.data
  expect(dustLostEventData.account.toString()).toBe(encodeAddress(alice.address, testConfig.addressEncoding))
  expect(dustLostEventData.amount.toBigInt()).toBe(eps)

  // Check `Endowed` event
  const endowedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'Endowed'
  })
  expect(endowedEvent).toBeDefined()
  assert(baseClient.api.events.balances.Endowed.is(endowedEvent!.event))
  const endowedEventData = endowedEvent!.event.data
  expect(endowedEventData.account.toString()).toBe(encodeAddress(bob.address, testConfig.addressEncoding))
  expect(endowedEventData.freeBalance.toBigInt()).toBe(existentialDeposit)

  // Check `KilledAccount` event
  const killedAccountEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'KilledAccount'
  })
  expect(killedAccountEvent).toBeDefined()
  assert(baseClient.api.events.system.KilledAccount.is(killedAccountEvent!.event))
  const killedAccountEventData = killedAccountEvent!.event.data
  expect(killedAccountEventData.account.toString()).toBe(encodeAddress(alice.address, testConfig.addressEncoding))

  // Check `NewAccount` event
  const newAccountEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'NewAccount'
  })
  expect(newAccountEvent).toBeDefined()
  assert(baseClient.api.events.system.NewAccount.is(newAccountEvent!.event))
  const newAccountEventData = newAccountEvent!.event.data
  expect(newAccountEventData.account.toString()).toBe(encodeAddress(bob.address, testConfig.addressEncoding))
}

/**
 * Test that `force_transfer` fails when transferring below existential deposit.
 *
 * 1. Create a fresh account with high balance
 * 2. Attempt to force transfer an amount below ED to another account using root origin
 * 3. Verify that the transaction fails
 * 4. Check that no transfer occurred (no fees, either)
 */
async function forceTransferBelowExistentialDepositTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesBase extends Record<string, Record<string, any>> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(
  baseChain: Chain<TCustom, TInitStoragesBase>,
  testConfig: TestConfig,
  relayChain?: Chain<TCustom, TInitStoragesRelay>,
) {
  let relayClient: Client<TCustom, TInitStoragesRelay>
  let baseClient: Client<TCustom, TInitStoragesBase>
  const [bc] = await setupNetworks(baseChain)

  // Check if scheduler pallet is available
  const hasScheduler = !!bc.api.tx.scheduler
  if (hasScheduler) {
    baseClient = bc
  } else {
    if (!relayChain) {
      throw new Error('Scheduler pallet not available and no relay chain provided for XCM execution')
    }

    const [rc, bc] = await setupNetworks(relayChain, baseChain)
    relayClient = rc
    baseClient = bc
  }

  // Create fresh accounts
  const existentialDeposit = baseClient.api.consts.balances.existentialDeposit.toBigInt()
  const aliceBalance = existentialDeposit * 100n // 100 ED
  const alice = await createAccountWithBalance(baseClient, aliceBalance, '//fresh_alice')
  const bob = testAccounts.keyring.createFromUri('//fresh_bob')

  // Verify initial state
  expect(await isAccountReaped(baseClient, alice.address)).toBe(false)
  expect(await isAccountReaped(baseClient, bob.address)).toBe(true)

  const transferAmount = existentialDeposit - 1n
  const forceTransferTx = baseClient.api.tx.balances.forceTransfer(alice.address, bob.address, transferAmount)

  if (hasScheduler) {
    // Use root origin to execute force transfer directly
    await scheduleInlineCallWithOrigin(
      baseClient,
      forceTransferTx.method.toHex(),
      { system: 'Root' },
      testConfig.blockProvider,
    )
    await baseClient.dev.newBlock()
  } else {
    // Query parachain ID
    const parachainInfo = await baseClient.api.query.parachainInfo.parachainId()
    const paraId = (parachainInfo as any).toNumber()

    // Create XCM transact message
    const xcmTx = createXcmTransactSend(
      relayClient!,
      {
        parents: 0,
        interior: {
          X1: [{ Parachain: paraId }],
        },
      },
      forceTransferTx.method.toHex(),
      'Superuser',
    )

    await scheduleInlineCallWithOrigin(relayClient!, xcmTx.method.toHex(), { system: 'Root' }, 'Local')

    // Advance blocks on both chains
    await relayClient!.dev.newBlock()
    await baseClient.dev.newBlock()
  }

  // Check that transaction failed with BelowMinimum error
  const events = await baseClient.api.query.system.events()
  const failedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })
  // No events are emitted from this failure, as it was the result of a manually injected scheduler call.
  expect(failedEvent).toBeUndefined()

  if (hasScheduler) {
    const dispatchedEvent = events.find((record) => {
      const { event } = record
      return event.section === 'scheduler' && event.method === 'Dispatched'
    })
    expect(dispatchedEvent).toBeDefined()
    assert(baseClient.api.events.scheduler.Dispatched.is(dispatchedEvent!.event))
    const dispatchData = dispatchedEvent!.event.data
    assert(dispatchData.result.isErr)
    const dispatchError = dispatchData.result.asErr

    assert(dispatchError.isToken)
    const tokenError = dispatchError.asToken
    assert(tokenError.isBelowMinimum)
  }

  // Verify no transfer occurred - Alice still has original balance, Bob still in oblivion
  expect(await isAccountReaped(baseClient, alice.address)).toBe(false)
  expect(await isAccountReaped(baseClient, bob.address)).toBe(true)

  // Alice's balance should be unchanged (no fees for failed force transfers)
  const aliceAccount = await baseClient.api.query.system.account(alice.address)
  expect(aliceAccount.data.free.toBigInt()).toBe(aliceBalance)
}

/**
 * Test force transfer when source has insufficient funds.
 *
 * 1. Create Alice with some balance
 * 2. Try to force transfer more than Alice has to Bob
 * 3. Verify the transaction fails
 * 4. Check that Alice's balance is unchanged (no fees for force transfers)
 */
async function forceTransferInsufficientFundsTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesBase extends Record<string, Record<string, any>> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(
  baseChain: Chain<TCustom, TInitStoragesBase>,
  testConfig: TestConfig,
  relayChain?: Chain<TCustom, TInitStoragesRelay>,
) {
  let relayClient: Client<TCustom, TInitStoragesRelay>
  let baseClient: Client<TCustom, TInitStoragesBase>
  const [bc] = await setupNetworks(baseChain)

  // Check if scheduler pallet is available
  const hasScheduler = !!bc.api.tx.scheduler
  if (hasScheduler) {
    baseClient = bc
  } else {
    if (!relayChain) {
      throw new Error('Scheduler pallet not available and no relay chain provided for XCM execution')
    }

    const [rc, bc] = await setupNetworks(relayChain, baseChain)
    relayClient = rc
    baseClient = bc
  }

  // Create fresh accounts
  const existentialDeposit = baseClient.api.consts.balances.existentialDeposit.toBigInt()
  const aliceBalance = existentialDeposit
  const alice = await createAccountWithBalance(baseClient, aliceBalance, '//fresh_alice')
  const bob = testAccounts.keyring.createFromUri('//fresh_bob')

  expect(await isAccountReaped(baseClient, alice.address)).toBe(false)
  expect(await isAccountReaped(baseClient, bob.address)).toBe(true)

  // Try to force transfer more than Alice has (2 ED when she only has 1)
  const transferAmount = 2n * aliceBalance
  const forceTransferTx = baseClient.api.tx.balances.forceTransfer(alice.address, bob.address, transferAmount)

  if (hasScheduler) {
    await scheduleInlineCallWithOrigin(
      baseClient,
      forceTransferTx.method.toHex(),
      { system: 'Root' },
      testConfig.blockProvider,
    )
    await baseClient.dev.newBlock()
  } else {
    // Query parachain ID
    const parachainInfo = await baseClient.api.query.parachainInfo.parachainId()
    const paraId = (parachainInfo as any).toNumber()

    // Create XCM transact message
    const xcmTx = createXcmTransactSend(
      relayClient!,
      {
        parents: 0,
        interior: {
          X1: [{ Parachain: paraId }],
        },
      },
      forceTransferTx.method.toHex(),
      'Superuser',
    )

    await scheduleInlineCallWithOrigin(relayClient!, xcmTx.method.toHex(), { system: 'Root' }, 'Local')

    // Advance blocks on both chains
    await relayClient!.dev.newBlock()
    await baseClient.dev.newBlock()
  }

  // Check for failure
  const events = await baseClient.api.query.system.events()

  if (hasScheduler) {
    const dispatchedEvent = events.find((record) => {
      const { event } = record
      return event.section === 'scheduler' && event.method === 'Dispatched'
    })
    expect(dispatchedEvent).toBeDefined()
    assert(baseClient.api.events.scheduler.Dispatched.is(dispatchedEvent!.event))
    const dispatchData = dispatchedEvent!.event.data
    assert(dispatchData.result.isErr)
    const dispatchError = dispatchData.result.asErr

    assert(dispatchError.isToken)
    const tokenError = dispatchError.asToken
    assert(tokenError.isFundsUnavailable)
  }

  // Verify no transfer occurred
  expect(await isAccountReaped(baseClient, alice.address)).toBe(false)
  expect(await isAccountReaped(baseClient, bob.address)).toBe(true)

  // Alice's balance should be unchanged (no fees for failed force transfers)
  const aliceAccount = await baseClient.api.query.system.account(alice.address)
  expect(aliceAccount.data.free.toBigInt()).toBe(aliceBalance)
}

/**
 * Test that `force_transfer` with reserve does not kill the source account.
 *
 * 1. Create a fresh account with 100+eps ED of balance
 * 2. Create a reserve on the account for 20 ED, increasing consumer count
 * 3. Force transfer Alice's remaining free balance to Bob
 *     - about 80 ED minus the fees for above reserve
 * 4. Verify that the transfer didn't occur, and thus the first account was NOT reaped due to the consumer ref
 * 5. Check that events emitted as a result of this operation contain correct data
 */
async function forceTransferWithReserveTest<
  TCustom extends Record<string, unknown>,
  TInitStoragesBase extends Record<string, Record<string, any>>,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(
  baseChain: Chain<TCustom, TInitStoragesBase>,
  testConfig: TestConfig,
  relayChain?: Chain<TCustom, TInitStoragesRelay>,
) {
  let relayClient: Client<TCustom, TInitStoragesRelay>
  let baseClient: Client<TCustom, TInitStoragesBase>
  const [bc] = await setupNetworks(baseChain)

  // Check if scheduler pallet is available - if not, a relay client needs to be created for an XCM interaction,
  // and the base client needs to be recreated simultaneously - otherwise, they would be unable to communicate.
  const hasScheduler = !!bc.api.tx.scheduler
  if (hasScheduler) {
    baseClient = bc
  } else {
    if (!relayChain) {
      throw new Error('Scheduler pallet not available and no relay chain provided for XCM execution')
    }

    const [rc, bc] = await setupNetworks(relayChain, baseChain)
    relayClient = rc
    baseClient = bc
  }

  // 1. Create fresh addresses, one with 100 ED (plus some extra for fees)
  const existentialDeposit = baseClient.api.consts.balances.existentialDeposit.toBigInt()
  const totalBalance = existentialDeposit * 100n + existentialDeposit
  const alice = await createAccountWithBalance(baseClient, totalBalance, '//fresh_alice')
  const bob = testAccounts.keyring.createFromUri('//fresh_bob')

  // Verify both accounts have expected initial state
  expect(await isAccountReaped(baseClient, alice.address)).toBe(false)
  expect(await isAccountReaped(baseClient, bob.address)).toBe(true)

  // Use the manual reserve action for this test to keep it simple
  const reserveAction = manualReserveAction<TCustom, TInitStoragesBase>()

  // 2. Execute reserve action to create a consumer

  const reservedAmount = await reserveAction.execute(baseClient, alice, existentialDeposit * 20n)
  await baseClient.dev.newBlock()

  // Get Alice's account state after reserve
  const aliceAccountAfterReserve = await baseClient.api.query.system.account(alice.address)
  expect(aliceAccountAfterReserve.consumers.toNumber()).toBeGreaterThanOrEqual(1)
  expect(aliceAccountAfterReserve.data.reserved.toBigInt()).toBe(reservedAmount)

  // 3. Force transfer Alice's remaining free balance to Bob; should be about 80 ED minus the fees for above reserve

  const aliceFreeBefore = aliceAccountAfterReserve.data.free.toBigInt()
  const transferAmount = aliceAccountAfterReserve.data.free.toBigInt()

  const forceTransferTx = baseClient.api.tx.balances.forceTransfer(alice.address, bob.address, transferAmount)

  if (hasScheduler) {
    // Use root origin to execute force transfer directly
    await scheduleInlineCallWithOrigin(
      baseClient,
      forceTransferTx.method.toHex(),
      { system: 'Root' },
      testConfig.blockProvider,
    )

    await baseClient.dev.newBlock()
  } else {
    // Query parachain ID
    const parachainInfo = await baseClient.api.query.parachainInfo.parachainId()
    const paraId = (parachainInfo as any).toNumber()

    // Create XCM transact message
    const xcmTx = createXcmTransactSend(
      relayClient!,
      {
        parents: 0,
        interior: {
          X1: [{ Parachain: paraId }],
        },
      },
      forceTransferTx.method.toHex(),
      'Superuser',
    )

    await scheduleInlineCallWithOrigin(relayClient!, xcmTx.method.toHex(), { system: 'Root' }, 'Local')

    // Advance blocks on both chains
    await relayClient!.dev.newBlock()
    await baseClient.dev.newBlock()
  }

  // 4. Check the transfer failed

  // Verify Alice's account was NOT reaped due to consumer count
  expect(await isAccountReaped(baseClient, alice.address)).toBe(false)
  expect(await isAccountReaped(baseClient, bob.address)).toBe(true)

  const aliceAccountFinal = await baseClient.api.query.system.account(alice.address)
  const bobAccount = await baseClient.api.query.system.account(bob.address)

  // Check final balances - Alice's balance should be unchanged (no fees for force transfers)
  expect(aliceAccountFinal.data.free.toBigInt()).toBe(aliceFreeBefore)
  expect(bobAccount.data.free.toBigInt()).toBe(0n)

  // Alice should still have consumers and reserved balance
  expect(aliceAccountFinal.consumers.toNumber()).toBeGreaterThanOrEqual(1)
  expect(aliceAccountFinal.providers.toNumber()).toBe(aliceAccountAfterReserve.providers.toNumber())
  expect(aliceAccountFinal.data.reserved.toBigInt()).toBe(reservedAmount)

  // 5. Check events

  const events = await baseClient.api.query.system.events()

  // Verify no `KilledAccount` events are present
  const killedAccountEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'KilledAccount'
  })
  expect(killedAccountEvent).toBeUndefined()

  // Check that no transfer event from Alice to Bob occurred
  const transferEvent = findTransferEvent(events, baseClient, alice.address, bob.address, testConfig.addressEncoding)
  expect(transferEvent).toBeUndefined()

  if (hasScheduler) {
    const dispatchedEvent = events.find((record) => {
      const { event } = record
      return event.section === 'scheduler' && event.method === 'Dispatched'
    })
    expect(dispatchedEvent).toBeDefined()
    assert(baseClient.api.events.scheduler.Dispatched.is(dispatchedEvent!.event))
    const dispatchData = dispatchedEvent!.event.data
    assert(dispatchData.result.isErr)
    const dispatchError = dispatchData.result.asErr

    assert(dispatchError.isToken)
    const tokenError = dispatchError.asToken
    expect(tokenError.isFrozen).toBeTruthy()
  }
}

/**
 * Test `force_transfer` with a bad origin (non-root).
 */
async function forceTransferBadOriginTest(chain: Chain) {
  const [client] = await setupNetworks(chain)

  // Create fresh accounts
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const transferAmount = existentialDeposit
  const alice = await createAccountWithBalance(client, existentialDeposit * 1000n, '//fresh_alice')
  const bob = testAccounts.bob

  const forceTransferTx = client.api.tx.balances.forceTransfer(alice.address, bob.address, transferAmount)
  await sendTransaction(forceTransferTx.signAsync(alice)) // Regular user, not root
  await client.dev.newBlock()

  const systemEvents = await client.api.query.system.events()
  const failedEvent = systemEvents.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  expect(failedEvent).toBeDefined()
  assert(client.api.events.system.ExtrinsicFailed.is(failedEvent!.event))
  const dispatchError = failedEvent!.event.data.dispatchError
  assert(dispatchError.isBadOrigin) // BadOrigin is a top-level DispatchError, not a module error
}

/**
 * Test self-transfer with `force_transfer`.
 *
 * 1. Create Alice with 100 ED
 * 2. The entirety of Alice's balance is forcefully transferred to herself
 * 3. Verify that the transfer is a no-op (no balance changes, no fees)
 * 4. Check that no transfer or other balance events occur
 */
async function forceTransferSelfTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesBase extends Record<string, Record<string, any>>,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(
  baseChain: Chain<TCustom, TInitStoragesBase>,
  testConfig: TestConfig,
  relayChain?: Chain<TCustom, TInitStoragesRelay>,
) {
  let relayClient: Client<TCustom, TInitStoragesRelay>
  let baseClient: Client<TCustom, TInitStoragesBase>
  const [bc] = await setupNetworks(baseChain)

  // Check if scheduler pallet is available
  const hasScheduler = !!bc.api.tx.scheduler
  if (hasScheduler) {
    baseClient = bc
  } else {
    if (!relayChain) {
      throw new Error('Scheduler pallet not available and no relay chain provided for XCM execution')
    }

    const [rc, bc] = await setupNetworks(relayChain, baseChain)
    relayClient = rc
    baseClient = bc
  }

  // 1. Create Alice's account
  const existentialDeposit = baseClient.api.consts.balances.existentialDeposit.toBigInt()
  const aliceBalance = existentialDeposit * 100n
  const alice = await createAccountWithBalance(baseClient, aliceBalance, '//fresh_alice')

  expect(await isAccountReaped(baseClient, alice.address)).toBe(false)

  // 2. Self-transfer all balance

  const forceTransferTx = baseClient.api.tx.balances.forceTransfer(alice.address, alice.address, aliceBalance)

  if (hasScheduler) {
    // Use root origin to execute force transfer directly
    await scheduleInlineCallWithOrigin(
      baseClient,
      forceTransferTx.method.toHex(),
      { system: 'Root' },
      testConfig.blockProvider,
    )
    await baseClient.dev.newBlock()
  } else {
    // Query parachain ID
    const parachainInfo = await baseClient.api.query.parachainInfo.parachainId()
    const paraId = (parachainInfo as any).toNumber()

    // Create XCM transact message
    const xcmTx = createXcmTransactSend(
      relayClient!,
      {
        parents: 0,
        interior: {
          X1: [{ Parachain: paraId }],
        },
      },
      forceTransferTx.method.toHex(),
      'Superuser',
    )

    await scheduleInlineCallWithOrigin(relayClient!, xcmTx.method.toHex(), { system: 'Root' }, 'Local')
    await baseClient.dev.newBlock()
  }

  // 3. Verify that the transaction succeeded (no ExtrinsicFailed event)

  const events = await baseClient.api.query.system.events()
  const failedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })
  expect(failedEvent).toBeUndefined()

  // 4. Verify Alice's balance is unchanged (force transfers have no fees, self-transfer should be no-op)

  const aliceAccount = await baseClient.api.query.system.account(alice.address)
  expect(aliceAccount.data.free.toBigInt()).toBe(aliceBalance)

  // Verify no Transfer event occurred
  const transferEvent = findTransferEvent(events, baseClient, alice.address, alice.address, testConfig.addressEncoding)
  expect(transferEvent).toBeUndefined()

  // Verify no Endowed event occurred
  const endowedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'Endowed'
  })
  expect(endowedEvent).toBeUndefined()

  // Verify no KilledAccount event occurred
  const killedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'KilledAccount'
  })
  expect(killedEvent).toBeUndefined()

  // Verify Alice is still alive
  expect(await isAccountReaped(baseClient, alice.address)).toBe(false)
}

// --------------
// `transfer_all`
// --------------

/**
 * Test that `transfer_all` with `keepAlive = true` transfers all but 1 ED.
 *
 * 1. Create an account, Alice, with 100 ED
 * 2. Transfer all funds to another account, Bob, with `keepAlive = true`
 * 3. Verify that transfer succeeds
 *     - Alice keeps exactly 1 ED (existential deposit)
 *     - Bob gets 99 ED minus transaction fees
 * 4. Verify that events emitted as a result of this operation contain correct data
 */
async function transferAllKeepAliveTrueTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  // 1. Create and fund accounts

  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const aliceBalance = existentialDeposit * 100n // 100 ED
  const alice = await createAccountWithBalance(client, aliceBalance, '//fresh_alice')
  const bob = testAccounts.keyring.createFromUri('//fresh_bob')

  expect(await isAccountReaped(client, alice.address)).toBe(false)
  expect(await isAccountReaped(client, bob.address)).toBe(true)

  // 2. Transfer all funds to Bob with `keepAlive = true`

  const transferAllTx = client.api.tx.balances.transferAll(bob.address, true)
  const transferEvents = await sendTransaction(transferAllTx.signAsync(alice))

  await client.dev.newBlock()

  // Snapshot events
  await checkEvents(
    transferEvents,
    { section: 'balances', method: 'Endowed' },
    { section: 'system', method: 'NewAccount' },
  ).toMatchSnapshot('events when Alice transfers all to Bob with `keepAlive = true`')

  // 3. Verify that transfer succeeds

  // Verify both accounts are alive
  expect(await isAccountReaped(client, alice.address)).toBe(false)
  expect(await isAccountReaped(client, bob.address)).toBe(false)

  const aliceAccountFinal = await client.api.query.system.account(alice.address)
  const bobAccount = await client.api.query.system.account(bob.address)

  // Get the transaction fee
  const events = await client.api.query.system.events()
  const feeInfo = findFeeEvent(events, client.api, testConfig)
  assert(feeInfo, 'expected a TransactionFeePaid event')
  assert(feeInfo.tip === 0n, 'unexpected extrinsic tip')
  expect(feeInfo.actualFee).toBeGreaterThan(0n)

  // Alice should keep exactly 1 ED
  expect(aliceAccountFinal.data.free.toBigInt()).toBe(existentialDeposit)

  // Bob should get 99 ED minus the transaction fee
  const expectedBobBalance = existentialDeposit * 99n - feeInfo.actualFee
  expect(bobAccount.data.free.toBigInt()).toBe(expectedBobBalance)

  // 4. Check events

  // No `KilledAccount` events
  const killedAccountEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'KilledAccount'
  })
  expect(killedAccountEvent).toBeUndefined()

  // Check transfer event
  const transferEvent = findTransferEvent(events, client, alice.address, bob.address, testConfig.addressEncoding)
  expect(transferEvent).toBeDefined()
  assert(client.api.events.balances.Transfer.is(transferEvent!.event))
  const transferEventData = transferEvent!.event.data
  expect(transferEventData.from.toString()).toBe(encodeAddress(alice.address, testConfig.addressEncoding))
  expect(transferEventData.to.toString()).toBe(encodeAddress(bob.address, testConfig.addressEncoding))
  expect(transferEventData.amount.toBigInt()).toBe(expectedBobBalance)
}

/**
 * Test that `transfer_all` with `keepAlive = false` kills the sender account.
 *
 * 1. Create an account, Alice, with 100 ED
 * 2. Transfer all funds to another account, Bob, with `keepAlive = false`
 * 3. Verify that transfer succeeds and Alice is killed
 *     - Alice account is reaped (KilledAccount event)
 *     - Bob gets all 100 ED minus transaction fees
 * 4. Verify that events emitted as a result of this operation contain correct data
 */
async function transferAllKeepAliveFalseTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  // 1. Create and fund accounts

  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const aliceBalance = existentialDeposit * 100n // 100 ED
  const alice = await createAccountWithBalance(client, aliceBalance, '//fresh_alice')
  const bob = testAccounts.keyring.createFromUri('//fresh_bob')

  expect(await isAccountReaped(client, alice.address)).toBe(false)
  expect(await isAccountReaped(client, bob.address)).toBe(true)

  // 2. Transfer all funds to Bob with `keepAlive = false`

  const transferAllTx = client.api.tx.balances.transferAll(bob.address, false)
  const transferEvents = await sendTransaction(transferAllTx.signAsync(alice))

  await client.dev.newBlock()

  // Snapshot events
  await checkEvents(
    transferEvents,
    { section: 'balances', method: 'Endowed' },
    { section: 'system', method: 'KilledAccount' },
    { section: 'system', method: 'NewAccount' },
  ).toMatchSnapshot('events when Alice transfers all to Bob with `keepAlive = false`')

  // 3. Verify that transfer succeeds, and Alice is killed

  // Verify Alice is reaped, Bob is alive
  expect(await isAccountReaped(client, alice.address)).toBe(true)
  expect(await isAccountReaped(client, bob.address)).toBe(false)

  const bobAccount = await client.api.query.system.account(bob.address)

  // Get the transaction fee
  const events = await client.api.query.system.events()
  const feeInfo = findFeeEvent(events, client.api, testConfig)
  assert(feeInfo, 'expected a TransactionFeePaid event')
  assert(feeInfo.tip === 0n, 'unexpected extrinsic tip')
  expect(feeInfo.actualFee).toBeGreaterThan(0n)

  // Bob should get all 100 ED minus the transaction fee
  const expectedBobBalance = aliceBalance - feeInfo.actualFee
  expect(bobAccount.data.free.toBigInt()).toBe(expectedBobBalance)

  // 4. Check events

  // Check `KilledAccount` event
  const killedAccountEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'KilledAccount'
  })
  expect(killedAccountEvent).toBeDefined()
  assert(client.api.events.system.KilledAccount.is(killedAccountEvent!.event))
  const killedAccountEventData = killedAccountEvent!.event.data
  expect(killedAccountEventData.account.toString()).toBe(encodeAddress(alice.address, testConfig.addressEncoding))

  // Check transfer event
  const transferEvent = findTransferEvent(events, client, alice.address, bob.address, testConfig.addressEncoding)
  expect(transferEvent).toBeDefined()
  assert(client.api.events.balances.Transfer.is(transferEvent!.event))
  const transferEventData = transferEvent!.event.data
  expect(transferEventData.from.toString()).toBe(encodeAddress(alice.address, testConfig.addressEncoding))
  expect(transferEventData.to.toString()).toBe(encodeAddress(bob.address, testConfig.addressEncoding))
  expect(transferEventData.amount.toBigInt()).toBe(expectedBobBalance)
}

/**
 * Test that `transfer_all` with reserve does not kill the sender account.
 *
 * 1. Create a fresh account with 100+eps ED of balance
 * 2. Create a reserve on the account for 20 ED, increasing consumer count
 * 3. Transfer all free balance to another account
 * 4. Verify that the transfer occurred, but with the first account NOT having been reaped due to the consumer ref
 *   - it will have kept 1 ED as free balance, and 20 as reserved balance, with no changes to consumer refs
 * 5. Check that events emitted as a result of this operation contain correct data
 */
async function transferAllWithReserveTest<
  TCustom extends Record<string, unknown>,
  TInitStorages extends Record<string, Record<string, any>>,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  // 1. Create fresh addresses, one with 100 ED (plus some extra for fees)
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const totalBalance = existentialDeposit * 100n + existentialDeposit
  const alice = await createAccountWithBalance(client, totalBalance, '//fresh_alice')
  const bob = testAccounts.keyring.createFromUri('//fresh_bob')

  // Verify both accounts have expected initial state
  expect(await isAccountReaped(client, alice.address)).toBe(false)
  expect(await isAccountReaped(client, bob.address)).toBe(true)

  // Use manual reservation action
  const reserveAction = manualReserveAction<TCustom, TInitStorages>()

  // 2. Execute reserve action to create a consumer

  const reservedAmount = await reserveAction.execute(client, alice, 1n)
  await client.dev.newBlock()

  // Initialize fee tracking map before any transactions
  const cumulativeFees = new Map<string, bigint>()
  await updateCumulativeFees(client.api, cumulativeFees, testConfig)

  // Get Alice's account state after reserve
  const aliceAccountAfterReserve = await client.api.query.system.account(alice.address)
  expect(aliceAccountAfterReserve.consumers.toNumber()).toBeGreaterThanOrEqual(1)
  expect(aliceAccountAfterReserve.data.reserved.toBigInt()).toBe(reservedAmount)

  // 3. Transfer all free balance to Bob

  // Calculate how much free balance Alice has left after reserve and prepare transfer
  const transferAllTx = client.api.tx.balances.transferAll(bob.address, false) // keepAlive = false
  const transferEvents = await sendTransaction(transferAllTx.signAsync(alice))

  await client.dev.newBlock()

  await updateCumulativeFees(client.api, cumulativeFees, testConfig)

  // Snapshot events
  await checkEvents(
    transferEvents,
    { section: 'balances', method: 'Endowed' },
    { section: 'system', method: 'NewAccount' },
  )
    .redact({ number: 0 })
    .toMatchSnapshot('events when Alice with reserve transfers all to Bob')

  // 4. Check the transfer succeeded

  // Verify Alice's account was NOT reaped due to consumer count
  expect(await isAccountReaped(client, alice.address)).toBe(false)
  expect(await isAccountReaped(client, bob.address)).toBe(false)

  const aliceAccountFinal = await client.api.query.system.account(alice.address)
  const bobAccount = await client.api.query.system.account(bob.address)

  // Check final balances
  expect(aliceAccountFinal.data.free.toBigInt()).toBe(existentialDeposit)
  // Bob gets all of Alice's balance, minus the fee for the transfer tx, and the existential deposit
  // to keep Alice's account alive
  expect(bobAccount.data.free.toBigInt()).toBe(
    totalBalance -
      reservedAmount -
      existentialDeposit -
      cumulativeFees.get(encodeAddress(alice.address, testConfig.addressEncoding))!,
  )

  // Alice should still have consumers and reserved balance
  expect(aliceAccountFinal.consumers.toNumber()).toBeGreaterThanOrEqual(1)
  expect(aliceAccountFinal.providers.toNumber()).toBe(aliceAccountAfterReserve.providers.toNumber())
  expect(aliceAccountFinal.data.reserved.toBigInt()).toBe(reservedAmount)

  // 5. Check events

  const events = await client.api.query.system.events()

  // Check endowment event
  const endowedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'Endowed'
  })
  expect(endowedEvent).toBeDefined()
  assert(client.api.events.balances.Endowed.is(endowedEvent!.event))
  const endowedEventData = endowedEvent!.event.data
  expect(endowedEventData.freeBalance.toBigInt()).toBe(bobAccount.data.free.toBigInt())
  expect(endowedEventData.account.toString()).toBe(encodeAddress(bob.address, testConfig.addressEncoding))

  // Verify no `KilledAccount˝ events are present
  const killedAccountEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'KilledAccount'
  })
  expect(killedAccountEvent).toBeUndefined()

  // Check that a transfer event from Alice to Bob occurred
  const transferEvent = findTransferEvent(events, client, alice.address, bob.address, testConfig.addressEncoding)
  expect(transferEvent).toBeDefined()
  assert(client.api.events.balances.Transfer.is(transferEvent!.event))
  const transferEventData = transferEvent!.event.data
  expect(transferEventData.from.toString()).toBe(encodeAddress(alice.address, testConfig.addressEncoding))
  expect(transferEventData.to.toString()).toBe(encodeAddress(bob.address, testConfig.addressEncoding))
  expect(transferEventData.amount.toBigInt()).toBe(
    totalBalance -
      reservedAmount -
      existentialDeposit -
      cumulativeFees.get(encodeAddress(alice.address, testConfig.addressEncoding))!,
  )
}

/**
 * Test self-transfer with `transfer_all` and `keepAlive = true`.
 *
 * 1. Create Alice with 100 ED
 * 2. Alice transfers all to herself with `keepAlive = true`
 * 3. Verify that the transfer is a no-op (only fees deducted)
 * 4. Check that Alice keeps her balance minus fees
 */
async function transferAllSelfKeepAliveTrueTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  // 1. Create Alice's account

  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const aliceBalance = existentialDeposit * 100n
  const alice = await createAccountWithBalance(client, aliceBalance, '//fresh_alice')

  expect(await isAccountReaped(client, alice.address)).toBe(false)

  // 2. Self-transfer all with keepAlive = true

  const transferAllTx = client.api.tx.balances.transferAll(alice.address, true)
  await sendTransaction(transferAllTx.signAsync(alice))

  await client.dev.newBlock()

  // 3. Verify that the transaction succeeded (no ExtrinsicFailed event)

  const events = await client.api.query.system.events()
  const failedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })
  expect(failedEvent).toBeUndefined()

  // 4. Verify Alice's balance only changed by fees (self-transfer should be no-op)

  // Get fee
  const feeInfo = findFeeEvent(events, client.api, testConfig)
  assert(feeInfo, 'expected a TransactionFeePaid event')
  assert(feeInfo.tip === 0n, 'unexpected extrinsic tip')
  expect(feeInfo.actualFee).toBeGreaterThan(0n)

  // Verify Alice's balance only decreased by fees (self-transfer should be no-op)
  const aliceAccount = await client.api.query.system.account(alice.address)
  expect(aliceAccount.data.free.toBigInt()).toBe(aliceBalance - feeInfo.actualFee)

  // Verify no Transfer event occurred
  const transferEvent = findTransferEvent(events, client, alice.address, alice.address, testConfig.addressEncoding)
  expect(transferEvent).toBeUndefined()

  // Verify no Endowed event occurred
  const endowedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'Endowed'
  })
  expect(endowedEvent).toBeUndefined()

  // Verify no KilledAccount event occurred
  const killedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'KilledAccount'
  })
  expect(killedEvent).toBeUndefined()

  // Verify Alice is still alive
  expect(await isAccountReaped(client, alice.address)).toBe(false)
}

/**
 * Test self-transfer with `transfer_all` and `keepAlive = false`.
 *
 * 1. Create Alice with 100 ED
 * 2. Alice transfers all to herself with `keepAlive = false`
 * 3. Verify that the transfer is a no-op (only fees deducted)
 * 4. Check that Alice keeps her balance minus fees
 */
async function transferAllSelfKeepAliveFalseTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  // 1. Create Alice's account

  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const aliceBalance = existentialDeposit * 100n
  const alice = await createAccountWithBalance(client, aliceBalance, '//fresh_alice')

  expect(await isAccountReaped(client, alice.address)).toBe(false)

  // 2. Self-transfer all with keepAlive = false

  const transferAllTx = client.api.tx.balances.transferAll(alice.address, false)
  await sendTransaction(transferAllTx.signAsync(alice))

  await client.dev.newBlock()

  // 3. Verify that the transaction succeeded (no ExtrinsicFailed event)

  const events = await client.api.query.system.events()
  const failedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })
  expect(failedEvent).toBeUndefined()

  // 4. Verify Alice's balance only changed by fees (self-transfer should be no-op)

  // Get fee
  const feeInfo = findFeeEvent(events, client.api, testConfig)
  assert(feeInfo, 'expected a TransactionFeePaid event')
  assert(feeInfo.tip === 0n, 'unexpected extrinsic tip')
  expect(feeInfo.actualFee).toBeGreaterThan(0n)

  // Verify Alice's balance only decreased by fees (self-transfer should be no-op)
  const aliceAccount = await client.api.query.system.account(alice.address)
  expect(aliceAccount.data.free.toBigInt()).toBe(aliceBalance - feeInfo.actualFee)

  // Verify no Transfer event occurred
  const transferEvent = findTransferEvent(events, client, alice.address, alice.address, testConfig.addressEncoding)
  expect(transferEvent).toBeUndefined()

  // Verify no Endowed event occurred
  const endowedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'Endowed'
  })
  expect(endowedEvent).toBeUndefined()

  // Verify no KilledAccount event occurred
  const killedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'KilledAccount'
  })
  expect(killedEvent).toBeUndefined()

  // Verify Alice is still alive
  expect(await isAccountReaped(client, alice.address)).toBe(false)
}

// ---------------------
// `transfer_keep_alive`
// ---------------------

/**
 * Test that `transfer_keep_alive` fails when sender has insufficient funds.
 *
 * 1. Create a fresh account with some balance
 * 2. Attempt to transfer more than the account has to another account
 * 3. Verify that the transaction fails
 * 4. Check that no transfer occurred and only fees were deducted
 */
async function transferKeepAliveInsufficientFundsTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const lambda = (client: Client<TCustom, TInitStorages>, bob: string, amount: bigint) =>
    client.api.tx.balances.transferKeepAlive(bob, amount)
  await transferInsufficientFundsTest(chain, testConfig, lambda)
}

/**
 * Test self-transfer with `transfer_keep_alive`.
 *
 * 1. Create Alice with 100 ED
 * 2. Alice transfers 100 ED to herself
 * 3. Verify that the transfer fails
 * 4. Check that Alice's balance only decreased by the transaction fee
 */
async function transferKeepAliveSelfTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  // 1. Create Alice's account

  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const aliceBalance = existentialDeposit * 100n
  const alice = await createAccountWithBalance(client, aliceBalance, '//fresh_alice')

  expect(await isAccountReaped(client, alice.address)).toBe(false)

  // 2. Self-transfer

  const transferAmount = existentialDeposit * 100n
  const transferTx = client.api.tx.balances.transferKeepAlive(alice.address, transferAmount)
  await sendTransaction(transferTx.signAsync(alice))

  await client.dev.newBlock()

  // 3. Verify that the transaction failed

  const events = await client.api.query.system.events()
  const failedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })
  expect(failedEvent).toBeDefined()
  assert(client.api.events.system.ExtrinsicFailed.is(failedEvent!.event))
  const dispatchError = failedEvent!.event.data.dispatchError
  assert(dispatchError.isToken)
  const tokenError = dispatchError.asToken
  assert(tokenError.isFundsUnavailable)

  // 4. Verify Alice's balance

  // Get fee
  const feeInfo = findFeeEvent(events, client.api, testConfig)
  assert(feeInfo, 'expected a TransactionFeePaid event')
  assert(feeInfo.tip === 0n, 'unexpected extrinsic tip')
  expect(feeInfo.actualFee).toBeGreaterThan(0n)

  // Verify Alice's balance

  const aliceAccount = await client.api.query.system.account(alice.address)
  expect(aliceAccount.data.free.toBigInt()).toBe(aliceBalance - feeInfo.actualFee)
}

/**
 * Test self-transfer with `transfer_keep_alive` - successful case.
 *
 * 1. Create Alice with 100 ED
 * 2. Alice transfers 50 ED to herself
 * 3. Verify that the transfer succeeds (is a no-op)
 * 4. Check that Alice's balance only decreased by the transaction fee
 */
async function transferKeepAliveSelfSuccessTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  // 1. Create Alice's account

  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const aliceBalance = existentialDeposit * 100n
  const alice = await createAccountWithBalance(client, aliceBalance, '//fresh_alice')

  expect(await isAccountReaped(client, alice.address)).toBe(false)

  // 2. Self-transfer half the balance

  const transferAmount = existentialDeposit * 50n // Transfer half
  const transferTx = client.api.tx.balances.transferKeepAlive(alice.address, transferAmount)
  await sendTransaction(transferTx.signAsync(alice))

  await client.dev.newBlock()

  // 3. Verify that the transaction succeeded (no ExtrinsicFailed event)

  const events = await client.api.query.system.events()
  const failedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })
  expect(failedEvent).toBeUndefined()

  // 4. Verify Alice's balance only changed by fees (no actual transfer for self-transfer)

  // Get fee
  const feeInfo = findFeeEvent(events, client.api, testConfig)
  assert(feeInfo, 'expected a TransactionFeePaid event')
  assert(feeInfo.tip === 0n, 'unexpected extrinsic tip')
  expect(feeInfo.actualFee).toBeGreaterThan(0n)

  // Verify Alice's balance only decreased by fees (self-transfer should be no-op)
  const aliceAccount = await client.api.query.system.account(alice.address)
  expect(aliceAccount.data.free.toBigInt()).toBe(aliceBalance - feeInfo.actualFee)

  // Verify no Transfer event occurred
  const transferEvent = findTransferEvent(events, client, alice.address, alice.address, testConfig.addressEncoding)
  expect(transferEvent).toBeUndefined()

  // Verify no Endowed event occurred
  const endowedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'Endowed'
  })
  expect(endowedEvent).toBeUndefined()
}

/**
 * Test that `transfer_keep_alive` fails when trying to transfer below ED.
 *
 * 1. Create account, Alice, with 100 ED
 * 2. Attempt to transfer 99 ED to Bob
 *    - this would leave Alice with 1 ED minus fees, which would be below ED
 * 3. Verify that the transaction fails
 * 4. Check that Bob's account remains inexistent, and that Alice only lost fees
 */
async function transferKeepAliveBelowEdTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  // 1. Create accounts, and endow Alice with funds

  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const aliceBalance = existentialDeposit * 100n // 100 ED
  const alice = await createAccountWithBalance(client, aliceBalance, '//fresh_alice')
  const bob = testAccounts.keyring.createFromUri('//fresh_bob')

  expect(await isAccountReaped(client, alice.address)).toBe(false)
  expect(await isAccountReaped(client, bob.address)).toBe(true)

  // 2. Try to transfer 99 ED from Alice to Bob

  const transferAmount = existentialDeposit * 99n
  const transferKeepAliveTx = client.api.tx.balances.transferKeepAlive(bob.address, transferAmount)
  await sendTransaction(transferKeepAliveTx.signAsync(alice))

  await client.dev.newBlock()

  // 3. Verify that the transaction failed

  const events = await client.api.query.system.events()
  const failedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  expect(failedEvent).toBeDefined()
  assert(client.api.events.system.ExtrinsicFailed.is(failedEvent!.event))
  const dispatchError = failedEvent!.event.data.dispatchError
  assert(dispatchError.isToken)
  const tokenError = dispatchError.asToken
  assert(tokenError.isNotExpendable)

  // Verify no transfer occurred - Alice still has funds, Bob still reaped
  expect(await isAccountReaped(client, alice.address)).toBe(false)
  expect(await isAccountReaped(client, bob.address)).toBe(true)

  // Get the transaction fee from the payment event
  const feeInfo = findFeeEvent(events, client.api, testConfig)
  assert(feeInfo, 'expected a TransactionFeePaid event')
  assert(feeInfo.tip === 0n, 'unexpected extrinsic tip')
  expect(feeInfo.actualFee).toBeGreaterThan(0n)

  // 4. Verify Alice and Bob's balances

  // Verify Alice's balance only decreased by the transaction fee
  const aliceAccount = await client.api.query.system.account(alice.address)
  expect(aliceAccount.data.free.toBigInt()).toBe(aliceBalance - feeInfo.actualFee)

  // Verify no endowment event for Bob
  const endowedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'Endowed'
  })
  expect(endowedEvent).toBeUndefined()

  // Verify no transfer event occurred
  const transferEvent = findTransferEvent(events, client, alice.address, bob.address, testConfig.addressEncoding)
  expect(transferEvent).toBeUndefined()
}

/**
 * Test that `transfer_keep_alive` fails, on low ED chains, when trying to transfer below ED.
 *
 * Low ED here means that the ED is below a typical transfer fee.
 *
 * 1. Create account, Alice, with 100 ED
 * 2. Attempt to transfer 99 ED to Bob
 *    - this would leave Alice with roughly 1 ED minus fees
 * 3. Verify that the transaction fails
 * 4. Check that Bob's account remains inexistent, and that Alice only lost fees
 */
async function transferKeepAliveBelowEdLowEdTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  // 1. Create accounts, and endow Alice with funds

  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const aliceBalance = existentialDeposit * 100n // 100 ED
  const alice = await createAccountWithBalance(client, aliceBalance, '//fresh_alice')
  const bob = testAccounts.keyring.createFromUri('//fresh_bob')

  expect(await isAccountReaped(client, alice.address)).toBe(false)
  expect(await isAccountReaped(client, bob.address)).toBe(true)

  // 2. Try to transfer 99 ED from Alice to Bob (would leave Alice with insufficient funds after fees)

  const transferAmount = existentialDeposit * 99n
  const transferKeepAliveTx = client.api.tx.balances.transferKeepAlive(bob.address, transferAmount)
  await sendTransaction(transferKeepAliveTx.signAsync(alice))

  await client.dev.newBlock()

  // 3. Verify that the transaction failed

  const events = await client.api.query.system.events()
  const failedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  expect(failedEvent).toBeDefined()
  assert(client.api.events.system.ExtrinsicFailed.is(failedEvent!.event))
  const dispatchError = failedEvent!.event.data.dispatchError
  assert(dispatchError.isToken)
  const tokenError = dispatchError.asToken
  assert(tokenError.isFundsUnavailable)

  // Verify no transfer occurred - Alice still has funds, Bob still reaped
  expect(await isAccountReaped(client, alice.address)).toBe(false)
  expect(await isAccountReaped(client, bob.address)).toBe(true)

  // Get the transaction fee from the payment event
  const feeInfo = findFeeEvent(events, client.api, testConfig)
  assert(feeInfo, 'expected a TransactionFeePaid event')
  assert(feeInfo.tip === 0n, 'unexpected extrinsic tip')
  expect(feeInfo.actualFee).toBeGreaterThan(0n)

  // 4. Verify Alice and Bob's balances

  // Verify Alice's balance only decreased by the transaction fee
  const aliceAccount = await client.api.query.system.account(alice.address)
  expect(aliceAccount.data.free.toBigInt()).toBe(aliceBalance - feeInfo.actualFee)

  // Verify no endowment event for Bob
  const endowedEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'Endowed'
  })
  expect(endowedEvent).toBeUndefined()

  // Verify no transfer (Alice -> Bob) event occurred
  const transferEvent = findTransferEvent(events, client, alice.address, bob.address, testConfig.addressEncoding)
  expect(transferEvent).toBeUndefined()
}

// -----------------
// `force_unreserve`
// -----------------

/**
 * Test `force_unreserve` with a bad origin (non-root).
 */
async function forceUnreserveBadOriginTest(chain: Chain) {
  const [client] = await setupNetworks(chain)

  // Create fresh account
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const alice = await createAccountWithBalance(client, existentialDeposit * 1000n, '//fresh_alice')
  const unreserveAmount = existentialDeposit

  const forceUnreserveTx = client.api.tx.balances.forceUnreserve(alice.address, unreserveAmount)
  await sendTransaction(forceUnreserveTx.signAsync(alice))
  await client.dev.newBlock()

  const systemEvents = await client.api.query.system.events()
  const failedEvent = systemEvents.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  expect(failedEvent).toBeDefined()
  assert(client.api.events.system.ExtrinsicFailed.is(failedEvent!.event))
  const dispatchError = failedEvent!.event.data.dispatchError
  assert(dispatchError.isBadOrigin)
}

/**
 * Test `force_unreserve` on an account with no reserves: no-op.
 *
 * 1. Create Alice with 100 ED and no reserves
 * 2. Forcefully unreserve 0 from Alice
 * 3. Verify the action is a no-op
 * 4. Verify Alice's balance is unchanged
 */
async function forceUnreserveNoReservesTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesBase extends Record<string, Record<string, any>> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(
  baseChain: Chain<TCustom, TInitStoragesBase>,
  testConfig: TestConfig,
  relayChain?: Chain<TCustom, TInitStoragesRelay>,
) {
  let relayClient: Client<TCustom, TInitStoragesRelay>
  let baseClient: Client<TCustom, TInitStoragesBase>
  const [bc] = await setupNetworks(baseChain)

  // Check if scheduler pallet is available
  const hasScheduler = !!bc.api.tx.scheduler
  let paraId: number | undefined
  if (hasScheduler) {
    baseClient = bc
  } else {
    if (!relayChain) {
      throw new Error('Scheduler pallet not available and no relay chain provided for XCM execution')
    }

    const [rc, bc] = await setupNetworks(relayChain, baseChain)
    relayClient = rc
    baseClient = bc

    // Query parachain ID once for XCM operations
    const parachainInfo = await baseClient.api.query.parachainInfo.parachainId()
    paraId = (parachainInfo as any).toNumber()
  }

  // 1. Create Alice with 100 ED and no reserves

  const existentialDeposit = baseClient.api.consts.balances.existentialDeposit.toBigInt()
  const aliceBalance = existentialDeposit * 100n
  const alice = await createAccountWithBalance(baseClient, aliceBalance, '//fresh_alice')

  expect(await isAccountReaped(baseClient, alice.address)).toBe(false)

  // Verify Alice has no reserves
  const aliceAccountBefore = await baseClient.api.query.system.account(alice.address)
  expect(aliceAccountBefore.data.reserved.toBigInt()).toBe(0n)

  // 2. Forcefully unreserve 0 from Alice

  const unreserveAmount = 0n
  const forceUnreserveTx = baseClient.api.tx.balances.forceUnreserve(alice.address, unreserveAmount)

  if (hasScheduler) {
    await scheduleInlineCallWithOrigin(
      baseClient,
      forceUnreserveTx.method.toHex(),
      { system: 'Root' },
      testConfig.blockProvider,
    )
    await baseClient.dev.newBlock()
  } else {
    // Create XCM transact message
    const xcmTx = createXcmTransactSend(
      relayClient!,
      {
        parents: 0,
        interior: {
          X1: [{ Parachain: paraId! }],
        },
      },
      forceUnreserveTx.method.toHex(),
      'Superuser',
    )

    await scheduleInlineCallWithOrigin(relayClient!, xcmTx.method.toHex(), { system: 'Root' }, 'Local')

    // Advance blocks on both chains
    await relayClient!.dev.newBlock()
    await baseClient.dev.newBlock()
  }

  // 3. Verify no `balances.Unreserved` event is emitted

  const systemEvents = await baseClient.api.query.system.events()
  const unreservedEvent = systemEvents.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'Unreserved'
  })
  expect(unreservedEvent).toBeUndefined()

  // 4. Verify Alice's balance is unchanged
  const aliceAccountAfter = await baseClient.api.query.system.account(alice.address)
  expect(aliceAccountAfter.data.free.toBigInt()).toBe(aliceBalance)
  expect(aliceAccountAfter.data.reserved.toBigInt()).toBe(0n)
}

/**
 * Test `force_unreserve` on a non-existent account.
 *
 * 1. Create a fresh keypair (no balance)
 * 2. Forcefully unreserve some amount from the non-existent account
 * 3. Verify the action is a no-op
 * 4. Verify the account remains non-existent
 */
async function forceUnreserveNonExistentAccountTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesBase extends Record<string, Record<string, any>> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(
  baseChain: Chain<TCustom, TInitStoragesBase>,
  testConfig: TestConfig,
  relayChain?: Chain<TCustom, TInitStoragesRelay>,
) {
  let relayClient: Client<TCustom, TInitStoragesRelay>
  let baseClient: Client<TCustom, TInitStoragesBase>
  const [bc] = await setupNetworks(baseChain)

  // Check if scheduler pallet is available
  const hasScheduler = !!bc.api.tx.scheduler
  let paraId: number | undefined
  if (hasScheduler) {
    baseClient = bc
  } else {
    if (!relayChain) {
      throw new Error('Scheduler pallet not available and no relay chain provided for XCM execution')
    }

    const [rc, bc] = await setupNetworks(relayChain, baseChain)
    relayClient = rc
    baseClient = bc

    // Query parachain ID once for XCM operations
    const parachainInfo = await baseClient.api.query.parachainInfo.parachainId()
    paraId = (parachainInfo as any).toNumber()
  }

  // 1. Create a fresh keypair (no balance)
  const bob = testAccounts.keyring.createFromUri('//fresh_bob')
  expect(await isAccountReaped(baseClient, bob.address)).toBe(true)

  // 2. Forcefully unreserve some amount from the non-existent account

  const existentialDeposit = baseClient.api.consts.balances.existentialDeposit.toBigInt()
  const unreserveAmount = existentialDeposit
  const forceUnreserveTx = baseClient.api.tx.balances.forceUnreserve(bob.address, unreserveAmount)

  if (hasScheduler) {
    await scheduleInlineCallWithOrigin(
      baseClient,
      forceUnreserveTx.method.toHex(),
      { system: 'Root' },
      testConfig.blockProvider,
    )
    await baseClient.dev.newBlock()
  } else {
    // Create XCM transact message
    const xcmTx = createXcmTransactSend(
      relayClient!,
      {
        parents: 0,
        interior: {
          X1: [{ Parachain: paraId! }],
        },
      },
      forceUnreserveTx.method.toHex(),
      'Superuser',
    )

    await scheduleInlineCallWithOrigin(relayClient!, xcmTx.method.toHex(), { system: 'Root' }, 'Local')

    // Advance blocks on both chains
    await relayClient!.dev.newBlock()
    await baseClient.dev.newBlock()
  }

  // 3. Verify no `balances.Unreserved` event is emitted
  const systemEvents = await baseClient.api.query.system.events()
  const unreservedEvent = systemEvents.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'Unreserved'
  })
  expect(unreservedEvent).toBeUndefined()

  // 4. Verify the account remains non-existent
  expect(await isAccountReaped(baseClient, bob.address)).toBe(true)
}

/**
 * Test `force_unreserve` on an account with existing reserves.
 *
 * 1. Create Alice with 100 ED
 * 2. Create a reserve of 20 ED using any available deposit action
 *    - reserve actions are avoided in case the manual lock is chosen; since it's a manual storage modification,
 *      it'll interact poorly with the unreservation
 * 3. Forcefully unreserve 20 ED from Alice
 * 4. Verify `balances.Unreserved` event is emitted with correct data
 * 5. Verify Alice's reserved balance decreased and free balance increased
 */
async function forceUnreserveWithReservesTest<
  TCustom extends Record<string, unknown>,
  TInitStoragesBase extends Record<string, Record<string, any>>,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(
  baseChain: Chain<TCustom, TInitStoragesBase>,
  testConfig: TestConfig,
  relayChain?: Chain<TCustom, TInitStoragesRelay>,
) {
  let relayClient: Client<TCustom, TInitStoragesRelay>
  let baseClient: Client<TCustom, TInitStoragesBase>
  const [bc] = await setupNetworks(baseChain)

  // Check if scheduler pallet is available
  const hasScheduler = !!bc.api.tx.scheduler
  let paraId: number | undefined
  if (hasScheduler) {
    baseClient = bc
  } else {
    if (!relayChain) {
      throw new Error('Scheduler pallet not available and no relay chain provided for XCM execution')
    }

    const [rc, bc] = await setupNetworks(relayChain, baseChain)
    relayClient = rc
    baseClient = bc

    // Query parachain ID once for XCM operations
    const parachainInfo = await baseClient.api.query.parachainInfo.parachainId()
    paraId = (parachainInfo as any).toNumber()
  }

  // 1. Create Alice with 10000 ED

  const existentialDeposit = baseClient.api.consts.balances.existentialDeposit.toBigInt()
  const aliceBalance = existentialDeposit * 10000n
  const alice = await createAccountWithBalance(baseClient, aliceBalance, '//fresh_alice')

  expect(await isAccountReaped(baseClient, alice.address)).toBe(false)

  // Verify Alice starts with no reserves and no consumers
  const aliceAccountInitial = await baseClient.api.query.system.account(alice.address)
  expect(aliceAccountInitial.data.reserved.toBigInt()).toBe(0n)
  expect(aliceAccountInitial.data.free.toBigInt()).toBe(aliceBalance)
  expect(aliceAccountInitial.consumers.toNumber()).toBe(0)

  // 2. Create a reserve a multisig operation - available on most chains

  const multisigThreshold = 2n
  const multisigDeposit =
    baseClient.api.consts.multisig.depositBase.toBigInt() +
    multisigThreshold * baseClient.api.consts.multisig.depositFactor.toBigInt()
  const multisigTx = baseClient.api.tx.multisig.asMulti(
    multisigThreshold,
    [testAccounts.bob.address],
    null,
    baseClient.api.tx.system.remark('multisig test').method.toHex(),
    { refTime: 1000000, proofSize: 1000 },
  )
  await sendTransaction(multisigTx.signAsync(alice))
  await baseClient.dev.newBlock()

  // Verify the reserve was created and consumer count increased
  const aliceAccountAfterReserve = await baseClient.api.query.system.account(alice.address)
  expect(aliceAccountAfterReserve.data.reserved.toBigInt()).toBe(multisigDeposit)
  expect(aliceAccountAfterReserve.consumers.toNumber()).toEqual(1)
  const consumersAfterReserve = aliceAccountAfterReserve.consumers.toNumber()

  // 3. Forcefully unreserve 20 ED from Alice

  const unreserveAmount = multisigDeposit
  const forceUnreserveTx = baseClient.api.tx.balances.forceUnreserve(alice.address, unreserveAmount)

  if (hasScheduler) {
    await scheduleInlineCallWithOrigin(
      baseClient,
      forceUnreserveTx.method.toHex(),
      { system: 'Root' },
      testConfig.blockProvider,
    )
    await baseClient.dev.newBlock()
  } else {
    // Create XCM transact message
    const xcmTx = createXcmTransactSend(
      relayClient!,
      {
        parents: 0,
        interior: {
          X1: [{ Parachain: paraId! }],
        },
      },
      forceUnreserveTx.method.toHex(),
      'Superuser',
    )

    await scheduleInlineCallWithOrigin(relayClient!, xcmTx.method.toHex(), { system: 'Root' }, 'Local')

    // Advance blocks on both chains
    await relayClient!.dev.newBlock()
    await baseClient.dev.newBlock()
  }

  // 4. Verify `balances.Unreserved` event is emitted with correct data

  const systemEvents = await baseClient.api.query.system.events()
  const unreservedEvent = systemEvents.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'Unreserved'
  })

  expect(unreservedEvent).toBeDefined()
  assert(baseClient.api.events.balances.Unreserved.is(unreservedEvent!.event))
  const unreservedEventData = unreservedEvent!.event.data
  expect(unreservedEventData.who.toString()).toBe(encodeAddress(alice.address, testConfig.addressEncoding))
  expect(unreservedEventData.amount.toBigInt()).toBe(unreserveAmount)

  // 5. Verify Alice's reserved balance decreased, free balance increased, and consumer count decreased

  const aliceAccountFinal = await baseClient.api.query.system.account(alice.address)
  expect(aliceAccountFinal.data.reserved.toBigInt()).toBe(0n)

  // Free balance should be original balance minus any fees paid during reserve creation
  const expectedFreeBalance = aliceAccountAfterReserve.data.free.toBigInt() + unreserveAmount
  expect(aliceAccountFinal.data.free.toBigInt()).toBe(expectedFreeBalance)

  // Consumer count should have decreased back to 0 (or at least decreased from after reserve)
  const consumersAfterUnreserve = aliceAccountFinal.consumers.toNumber()
  expect(consumersAfterUnreserve).toBeLessThan(consumersAfterReserve)
  expect(consumersAfterUnreserve).toBe(0)
}

// -------------------
// `force_set_balance`
// -------------------

/**
 * Test `force_set_balance` with a bad origin (non-root).
 */
async function forceSetBalanceBadOriginTest(chain: Chain) {
  const [client] = await setupNetworks(chain)

  // Create fresh account
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const alice = await createAccountWithBalance(client, existentialDeposit * 1000n, '//fresh_alice')
  const newFree = existentialDeposit * 10n

  const forceSetBalanceTx = client.api.tx.balances.forceSetBalance(alice.address, newFree)
  await sendTransaction(forceSetBalanceTx.signAsync(alice))
  await client.dev.newBlock()

  const systemEvents = await client.api.query.system.events()
  const failedEvent = systemEvents.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  expect(failedEvent).toBeDefined()
  assert(client.api.events.system.ExtrinsicFailed.is(failedEvent!.event))
  const dispatchError = failedEvent!.event.data.dispatchError
  assert(dispatchError.isBadOrigin)
}

/**
 * Test `force_set_balance` successfully setting a balance.
 *
 * 1. Create Alice with 100 ED
 * 2. Force set Alice's balance to 101 ED
 * 3. Verify that the balance was set correctly
 * 4. Check new total issuance
 */
async function forceSetBalanceSuccessTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesBase extends Record<string, Record<string, any>> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(
  baseChain: Chain<TCustom, TInitStoragesBase>,
  testConfig: TestConfig,
  relayChain?: Chain<TCustom, TInitStoragesRelay>,
) {
  let relayClient: Client<TCustom, TInitStoragesRelay>
  let baseClient: Client<TCustom, TInitStoragesBase>
  const [bc] = await setupNetworks(baseChain)

  // Check if scheduler pallet is available
  const hasScheduler = !!bc.api.tx.scheduler
  if (hasScheduler) {
    baseClient = bc
  } else {
    if (!relayChain) {
      throw new Error('Scheduler pallet not available and no relay chain provided for XCM execution')
    }

    const [rc, bc] = await setupNetworks(relayChain, baseChain)
    relayClient = rc
    baseClient = bc
  }

  // 1. Create Alice's account with 100 ED

  const existentialDeposit = baseClient.api.consts.balances.existentialDeposit.toBigInt()
  const initialBalance = existentialDeposit * 100n
  const alice = await createAccountWithBalance(baseClient, initialBalance, '//fresh_alice')

  expect(await isAccountReaped(baseClient, alice.address)).toBe(false)

  // Verify initial balance
  const aliceAccountInitial = await baseClient.api.query.system.account(alice.address)
  expect(aliceAccountInitial.data.free.toBigInt()).toBe(initialBalance)

  // Query initial total issuance
  const initialTotalIssuance = await baseClient.api.query.balances.totalIssuance()

  // 2. Force set Alice's balance to 101 ED

  const newBalance = existentialDeposit * 101n
  const expectedIssuanceIncrease = newBalance - initialBalance
  const forceSetBalanceTx = baseClient.api.tx.balances.forceSetBalance(alice.address, newBalance)

  if (hasScheduler) {
    // Use root origin to execute force set balance directly
    await scheduleInlineCallWithOrigin(
      baseClient,
      forceSetBalanceTx.method.toHex(),
      { system: 'Root' },
      testConfig.blockProvider,
    )
    await baseClient.dev.newBlock()
  } else {
    // Query parachain ID
    const parachainInfo = await baseClient.api.query.parachainInfo.parachainId()
    const paraId = (parachainInfo as any).toNumber()

    // Create XCM transact message
    const xcmTx = createXcmTransactSend(
      relayClient!,
      {
        parents: 0,
        interior: {
          X1: [{ Parachain: paraId }],
        },
      },
      forceSetBalanceTx.method.toHex(),
      'Superuser',
    )

    await scheduleInlineCallWithOrigin(relayClient!, xcmTx.method.toHex(), { system: 'Root' }, 'Local')
    await relayClient!.dev.newBlock()
    await baseClient.dev.newBlock()
  }

  // 3. Verify that the transaction succeeded and balance was set

  // Verify Alice's balance was set to 101 ED
  const aliceAccountFinal = await baseClient.api.query.system.account(alice.address)
  expect(aliceAccountFinal.data.free.toBigInt()).toBe(newBalance)

  // Verify total issuance increased by the expected amount
  const finalTotalIssuance = await baseClient.api.query.balances.totalIssuance()
  const actualIssuanceIncrease = finalTotalIssuance.toBigInt() - initialTotalIssuance.toBigInt()
  expect(actualIssuanceIncrease).toBe(expectedIssuanceIncrease)

  // 4. Check events and new total issuance

  const events = await baseClient.api.query.system.events()

  // Check that a BalanceSet event was emitted
  const balanceSetEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'BalanceSet'
  })
  expect(balanceSetEvent).toBeDefined()
  assert(baseClient.api.events.balances.BalanceSet.is(balanceSetEvent!.event))

  const balanceSetEventData = balanceSetEvent!.event.data
  expect(balanceSetEventData.who.toString()).toBe(encodeAddress(alice.address, testConfig.addressEncoding))
  expect(balanceSetEventData.free.toBigInt()).toBe(newBalance)

  // Check new total issuance
  const newTotalIssuance = await baseClient.api.query.balances.totalIssuance()
  expect(newTotalIssuance.toBigInt()).toBe(initialTotalIssuance.toBigInt() + expectedIssuanceIncrease)

  // Verify Alice is still alive
  expect(await isAccountReaped(baseClient, alice.address)).toBe(false)
}

/**
 * Test `force_set_balance` setting balance below ED reaps the account.
 *
 * 1. Create Alice with 100 ED
 * 2. Force set Alice's balance to ED - 1 (below existential deposit)
 * 3. Verify that the account was reaped and total issuance decreased
 * 4. Check events
 */
async function forceSetBalanceBelowEdTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesBase extends Record<string, Record<string, any>> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(
  baseChain: Chain<TCustom, TInitStoragesBase>,
  testConfig: TestConfig,
  relayChain?: Chain<TCustom, TInitStoragesRelay>,
) {
  let relayClient: Client<TCustom, TInitStoragesRelay>
  let baseClient: Client<TCustom, TInitStoragesBase>
  const [bc] = await setupNetworks(baseChain)

  // Check if scheduler pallet is available
  const hasScheduler = !!bc.api.tx.scheduler
  if (hasScheduler) {
    baseClient = bc
  } else {
    if (!relayChain) {
      throw new Error('Scheduler pallet not available and no relay chain provided for XCM execution')
    }

    const [rc, bc] = await setupNetworks(relayChain, baseChain)
    relayClient = rc
    baseClient = bc
  }

  // 1. Create Alice's account with 100 ED

  const existentialDeposit = baseClient.api.consts.balances.existentialDeposit.toBigInt()
  const initialBalance = existentialDeposit * 100n
  const alice = await createAccountWithBalance(baseClient, initialBalance, '//fresh_alice')

  expect(await isAccountReaped(baseClient, alice.address)).toBe(false)

  // Verify initial balance
  const aliceAccountInitial = await baseClient.api.query.system.account(alice.address)
  expect(aliceAccountInitial.data.free.toBigInt()).toBe(initialBalance)

  // Query initial total issuance
  const initialTotalIssuance = await baseClient.api.query.balances.totalIssuance()

  // 2. Force set Alice's balance to ED - 1 (below existential deposit)

  const newBalance = existentialDeposit - 1n // Below ED
  const forceSetBalanceTx = baseClient.api.tx.balances.forceSetBalance(alice.address, newBalance)

  if (hasScheduler) {
    // Use root origin to execute force set balance directly
    await scheduleInlineCallWithOrigin(
      baseClient,
      forceSetBalanceTx.method.toHex(),
      { system: 'Root' },
      testConfig.blockProvider,
    )
    await baseClient.dev.newBlock()
  } else {
    // Query parachain ID
    const parachainInfo = await baseClient.api.query.parachainInfo.parachainId()
    const paraId = (parachainInfo as any).toNumber()

    // Create XCM transact message
    const xcmTx = createXcmTransactSend(
      relayClient!,
      {
        parents: 0,
        interior: {
          X1: [{ Parachain: paraId }],
        },
      },
      forceSetBalanceTx.method.toHex(),
      'Superuser',
    )

    await scheduleInlineCallWithOrigin(relayClient!, xcmTx.method.toHex(), { system: 'Root' }, 'Local')
    await relayClient!.dev.newBlock()
    await baseClient.dev.newBlock()
  }

  // 3. Verify that the transaction succeeded, and that Alice's account was reaped

  expect(await isAccountReaped(baseClient, alice.address)).toBe(true)

  // 4. Check events

  const events = await baseClient.api.query.system.events()

  // Check that a BalanceSet event was emitted
  const balanceSetEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'BalanceSet'
  })
  expect(balanceSetEvent).toBeDefined()
  assert(baseClient.api.events.balances.BalanceSet.is(balanceSetEvent!.event))

  const balanceSetEventData = balanceSetEvent!.event.data
  expect(balanceSetEventData.who.toString()).toBe(encodeAddress(alice.address, testConfig.addressEncoding))
  expect(balanceSetEventData.free.toBigInt()).toBe(0n)

  // Check that a KilledAccount event was emitted
  const killedAccountEvent = events.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'KilledAccount'
  })
  expect(killedAccountEvent).toBeDefined()
  assert(baseClient.api.events.system.KilledAccount.is(killedAccountEvent!.event))

  const killedAccountEventData = killedAccountEvent!.event.data
  expect(killedAccountEventData.account.toString()).toBe(encodeAddress(alice.address, testConfig.addressEncoding))

  // Check new total issuance
  const newTotalIssuance = await baseClient.api.query.balances.totalIssuance()
  expect(newTotalIssuance.toBigInt()).toBe(initialTotalIssuance.toBigInt() - initialBalance)
}

// -----------------------------
// `force_adjust_total_issuance`
// -----------------------------

/**
 * Test `force_adjust_total_issuance` with a bad origin (non-root).
 */
async function forceAdjustTotalIssuanceBadOriginTest(chain: Chain) {
  const [client] = await setupNetworks(chain)

  // Create fresh account
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const alice = await createAccountWithBalance(client, existentialDeposit * 1000n, '//fresh_alice')
  const direction = 'Increase'
  const delta = existentialDeposit

  const forceAdjustTotalIssuanceTx = client.api.tx.balances.forceAdjustTotalIssuance(direction, delta)
  await sendTransaction(forceAdjustTotalIssuanceTx.signAsync(alice))
  await client.dev.newBlock()

  const systemEvents = await client.api.query.system.events()
  const failedEvent = systemEvents.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  expect(failedEvent).toBeDefined()
  assert(client.api.events.system.ExtrinsicFailed.is(failedEvent!.event))
  const dispatchError = failedEvent!.event.data.dispatchError
  assert(dispatchError.isBadOrigin)
}

/**
 * Test `force_adjust_total_issuance` with zero delta in both directions.
 *
 * 1. Try to increase total issuance by 0
 * 2. Verify that the transaction fails
 * 3. Try to decrease total issuance by 0
 * 4. Verify that the transaction also fails
 */
async function forceAdjustTotalIssuanceZeroDeltaTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesBase extends Record<string, Record<string, any>> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(
  baseChain: Chain<TCustom, TInitStoragesBase>,
  testConfig: TestConfig,
  relayChain?: Chain<TCustom, TInitStoragesRelay>,
) {
  let relayClient: Client<TCustom, TInitStoragesRelay>
  let baseClient: Client<TCustom, TInitStoragesBase>
  const [bc] = await setupNetworks(baseChain)

  // Check if scheduler pallet is available
  const hasScheduler = !!bc.api.tx.scheduler
  let paraId: number | undefined
  if (hasScheduler) {
    baseClient = bc
  } else {
    if (!relayChain) {
      throw new Error('Scheduler pallet not available and no relay chain provided for XCM execution')
    }

    const [rc, bc] = await setupNetworks(relayChain, baseChain)
    relayClient = rc
    baseClient = bc

    // Query parachain ID once for XCM operations
    const parachainInfo = await baseClient.api.query.parachainInfo.parachainId()
    paraId = (parachainInfo as any).toNumber()
  }

  const issuanceBefore = (await baseClient.api.query.balances.totalIssuance()).toBigInt()

  // 1. Try to increase total issuance by 0

  const increaseDirection = 'Increase'
  const zeroDelta = 0n
  const forceAdjustIncreaseZeroTx = baseClient.api.tx.balances.forceAdjustTotalIssuance(increaseDirection, zeroDelta)

  if (hasScheduler) {
    await scheduleInlineCallWithOrigin(
      baseClient,
      forceAdjustIncreaseZeroTx.method.toHex(),
      { system: 'Root' },
      testConfig.blockProvider,
    )
    await baseClient.dev.newBlock()
  } else {
    // Create XCM transact message
    const xcmTx = createXcmTransactSend(
      relayClient!,
      {
        parents: 0,
        interior: {
          X1: [{ Parachain: paraId! }],
        },
      },
      forceAdjustIncreaseZeroTx.method.toHex(),
      'Superuser',
    )

    await scheduleInlineCallWithOrigin(relayClient!, xcmTx.method.toHex(), { system: 'Root' }, 'Local')

    // Advance blocks on both chains
    await relayClient!.dev.newBlock()
    await baseClient.dev.newBlock()
  }

  // 2. Verify that the increase transaction failed

  let events = await baseClient.api.query.system.events()

  if (hasScheduler) {
    const dispatchedEvent = events.find((record) => {
      const { event } = record
      return event.section === 'scheduler' && event.method === 'Dispatched'
    })
    expect(dispatchedEvent).toBeDefined()
    assert(baseClient.api.events.scheduler.Dispatched.is(dispatchedEvent!.event))
    const dispatchData = dispatchedEvent!.event.data
    assert(dispatchData.result.isErr)
    const dispatchError = dispatchData.result.asErr

    assert(dispatchError.isModule)
    const moduleError = dispatchError.asModule
    expect(baseClient.api.errors.balances.DeltaZero.is(moduleError)).toBe(true)
  }

  let issuanceEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'TotalIssuanceForced'
  })
  expect(issuanceEvent).toBeUndefined()

  const issuanceAfter = (await baseClient.api.query.balances.totalIssuance()).toBigInt()
  expect(issuanceAfter).toBe(issuanceBefore)

  // 3. Try to decrease total issuance by 0

  const decreaseDirection = 'Decrease'
  const forceAdjustDecreaseZeroTx = baseClient.api.tx.balances.forceAdjustTotalIssuance(decreaseDirection, zeroDelta)

  if (hasScheduler) {
    await scheduleInlineCallWithOrigin(
      baseClient,
      forceAdjustDecreaseZeroTx.method.toHex(),
      { system: 'Root' },
      testConfig.blockProvider,
    )
    await baseClient.dev.newBlock()
  } else {
    // Create XCM transact message
    const xcmTx = createXcmTransactSend(
      relayClient!,
      {
        parents: 0,
        interior: {
          X1: [{ Parachain: paraId! }],
        },
      },
      forceAdjustDecreaseZeroTx.method.toHex(),
      'Superuser',
    )

    await scheduleInlineCallWithOrigin(relayClient!, xcmTx.method.toHex(), { system: 'Root' }, 'Local')

    // Advance blocks on both chains
    await relayClient!.dev.newBlock()
    await baseClient.dev.newBlock()
  }

  // 4. Verify that the decrease transaction failed
  events = await baseClient.api.query.system.events()

  if (hasScheduler) {
    const dispatchedEvent = events.find((record) => {
      const { event } = record
      return event.section === 'scheduler' && event.method === 'Dispatched'
    })
    expect(dispatchedEvent).toBeDefined()
    assert(baseClient.api.events.scheduler.Dispatched.is(dispatchedEvent!.event))
    const dispatchData = dispatchedEvent!.event.data
    assert(dispatchData.result.isErr)
    const dispatchError = dispatchData.result.asErr

    assert(dispatchError.isModule)
    const moduleError = dispatchError.asModule
    expect(baseClient.api.errors.balances.DeltaZero.is(moduleError)).toBe(true)
  }

  issuanceEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'TotalIssuanceForced'
  })
  expect(issuanceEvent).toBeUndefined()

  const issuanceAfter2 = (await baseClient.api.query.balances.totalIssuance()).toBigInt()
  expect(issuanceAfter2).toBe(issuanceBefore)
}

/**
 * Test `force_adjust_total_issuance` with successful adjustments.
 *
 * 1. Get initial total issuance
 * 2. Increase total issuance by 1
 * 3. Verify the increase worked
 * 4. Decrease total issuance by 2
 * 5. Verify the decrease worked
 */
async function forceAdjustTotalIssuanceSuccessTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesBase extends Record<string, Record<string, any>> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(
  baseChain: Chain<TCustom, TInitStoragesBase>,
  testConfig: TestConfig,
  relayChain?: Chain<TCustom, TInitStoragesRelay>,
) {
  let relayClient: Client<TCustom, TInitStoragesRelay>
  let baseClient: Client<TCustom, TInitStoragesBase>
  const [bc] = await setupNetworks(baseChain)

  // Check if scheduler pallet is available
  const hasScheduler = !!bc.api.tx.scheduler
  let paraId: number | undefined
  if (hasScheduler) {
    baseClient = bc
  } else {
    if (!relayChain) {
      throw new Error('Scheduler pallet not available and no relay chain provided for XCM execution')
    }

    const [rc, bc] = await setupNetworks(relayChain, baseChain)
    relayClient = rc
    baseClient = bc

    // Query parachain ID once for XCM operations
    const parachainInfo = await baseClient.api.query.parachainInfo.parachainId()
    paraId = (parachainInfo as any).toNumber()
  }

  // 1. Get initial total issuance

  const initialIssuance = (await baseClient.api.query.balances.totalIssuance()).toBigInt()

  // 2. Increase total issuance by 1

  const increaseDirection = 'Increase'
  const increaseDelta = 1n
  const forceAdjustIncreaseTx = baseClient.api.tx.balances.forceAdjustTotalIssuance(increaseDirection, increaseDelta)

  if (hasScheduler) {
    await scheduleInlineCallWithOrigin(
      baseClient,
      forceAdjustIncreaseTx.method.toHex(),
      { system: 'Root' },
      testConfig.blockProvider,
    )
    await baseClient.dev.newBlock()
  } else {
    // Create XCM transact message
    const xcmTx = createXcmTransactSend(
      relayClient!,
      {
        parents: 0,
        interior: {
          X1: [{ Parachain: paraId! }],
        },
      },
      forceAdjustIncreaseTx.method.toHex(),
      'Superuser',
    )

    await scheduleInlineCallWithOrigin(relayClient!, xcmTx.method.toHex(), { system: 'Root' }, 'Local')

    // Advance blocks on both chains
    await relayClient!.dev.newBlock()
    await baseClient.dev.newBlock()
  }

  await checkSystemEvents(baseClient, { section: 'balances', method: 'TotalIssuanceForced' })
    .redact({ number: true })
    .toMatchSnapshot('events for first issuance change')

  // 3. Verify the increase worked

  const afterIncreaseIssuance = (await baseClient.api.query.balances.totalIssuance()).toBigInt()
  expect(afterIncreaseIssuance).toBe(initialIssuance + increaseDelta)

  // Check for TotalIssuanceForced event
  let systemEvents = await baseClient.api.query.system.events()
  let issuanceEvent = systemEvents.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'TotalIssuanceForced'
  })
  expect(issuanceEvent).toBeDefined()
  assert(baseClient.api.events.balances.TotalIssuanceForced.is(issuanceEvent!.event))
  let issuanceEventData = issuanceEvent!.event.data
  assert(issuanceEventData.old.eq(initialIssuance))
  assert(issuanceEventData.new_.eq(afterIncreaseIssuance))

  // 4. Decrease total issuance by 2

  const decreaseDirection = 'Decrease'
  const decreaseDelta = 2n
  const forceAdjustDecreaseTx = baseClient.api.tx.balances.forceAdjustTotalIssuance(decreaseDirection, decreaseDelta)

  if (hasScheduler) {
    await scheduleInlineCallWithOrigin(
      baseClient,
      forceAdjustDecreaseTx.method.toHex(),
      { system: 'Root' },
      testConfig.blockProvider,
    )
    await baseClient.dev.newBlock()
  } else {
    // Create XCM transact message
    const xcmTx = createXcmTransactSend(
      relayClient!,
      {
        parents: 0,
        interior: {
          X1: [{ Parachain: paraId! }],
        },
      },
      forceAdjustDecreaseTx.method.toHex(),
      'Superuser',
    )

    await scheduleInlineCallWithOrigin(relayClient!, xcmTx.method.toHex(), { system: 'Root' }, 'Local')

    // Advance blocks on both chains
    await relayClient!.dev.newBlock()
    await baseClient.dev.newBlock()
  }

  await checkSystemEvents(baseClient, { section: 'balances', method: 'TotalIssuanceForced' })
    .redact({ number: true })
    .toMatchSnapshot('events for second issuance change')

  // 5. Verify the decrease worked

  const finalIssuance = await baseClient.api.query.balances.totalIssuance()
  const finalIssuanceBigInt = finalIssuance.toBigInt()
  expect(finalIssuanceBigInt).toBe(afterIncreaseIssuance - decreaseDelta)
  expect(finalIssuanceBigInt).toBe(initialIssuance + increaseDelta - decreaseDelta)

  // Check for second TotalIssuanceForced event
  systemEvents = await baseClient.api.query.system.events()
  issuanceEvent = systemEvents.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'TotalIssuanceForced'
  })
  expect(issuanceEvent).toBeDefined()
  assert(baseClient.api.events.balances.TotalIssuanceForced.is(issuanceEvent!.event))
  issuanceEventData = issuanceEvent!.event.data
  assert(issuanceEventData.old.eq(afterIncreaseIssuance))
  assert(issuanceEventData.new_.eq(finalIssuanceBigInt))
}

// ------
// `burn`
// ------

/**
 * Test `burn`ing of funds.
 *
 * 1. Create Alice with 1000 ED
 * 2. Burn 500 ED
 * 3. Verify balance changes and total issuance decrease
 */
async function burnTestBaseCase<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  // 1. Create Alice with 1000 ED

  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const initialBalance = existentialDeposit * 1000n
  const alice = await createAccountWithBalance(client, initialBalance, '//fresh_alice')

  expect(await isAccountReaped(client, alice.address)).toBe(false)

  // Initialize fee tracking map
  const cumulativeFees = new Map<string, bigint>()

  // Query initial total issuance
  const initialTotalIssuance = await client.api.query.balances.totalIssuance()

  // 2. Alice burns 500 ED of her own

  const burnAmount = existentialDeposit * 500n
  const burnTx = client.api.tx.balances.burn(burnAmount, false)
  const burnEvents = await sendTransaction(burnTx.signAsync(alice))

  await client.dev.newBlock()

  // Update cumulative fees
  await updateCumulativeFees(client.api, cumulativeFees, testConfig)

  await checkEvents(burnEvents, { section: 'balances', method: 'Burned' }).toMatchSnapshot(
    'events when Alice self-burns funds',
  )

  // 3. Verify that funds were burned, and total issuance updated

  // Verify Alice is still alive
  expect(await isAccountReaped(client, alice.address)).toBe(false)

  const burnFee = cumulativeFees.get(encodeAddress(alice.address, testConfig.addressEncoding))!

  // Verify Alice's balance after burn
  const aliceAccountAfterBurn = await client.api.query.system.account(alice.address)
  const expectedBalanceAfterBurn = initialBalance - burnAmount - burnFee
  expect(aliceAccountAfterBurn.data.free.toBigInt()).toBe(expectedBalanceAfterBurn)

  // Check total issuance decreased by burn amount (fees are not included)
  const totalIssuanceAfterBurn = await client.api.query.balances.totalIssuance()
  expect(totalIssuanceAfterBurn.toBigInt()).toBe(initialTotalIssuance.toBigInt() - burnAmount)

  // Check burn event
  const eventsAfterBurn = await client.api.query.system.events()
  const burnEvent = eventsAfterBurn.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'Burned'
  })
  expect(burnEvent).toBeDefined()
  assert(client.api.events.balances.Burned.is(burnEvent!.event))
  const burnEventData = burnEvent!.event.data
  expect(burnEventData.who.toString()).toBe(encodeAddress(alice.address, testConfig.addressEncoding))
  expect(burnEventData.amount.toBigInt()).toBe(burnAmount)
}

/**
 * Test that the burning of an account's funds below ED leads to it being reaped.
 *
 * 1. Create Alice with 1000 ED
 * 2. Burn 999 ED (with `keep_alive` set to `false`)
 *     - fee deduction will bring the amount below ED, on chains whose ED is above a typical transaction fee
 *     - on other chains, this test cannot be run
 * 3. Verify that the account is reaped
 * 4. Verify that the total issuance is decreased by the amount burned, plus the amount lost as dust
 */
async function burnTestWithReaping<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  // 1. Create Alice with 1000 ED

  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const initialBalance = existentialDeposit * 1000n
  const alice = await createAccountWithBalance(client, initialBalance, '//fresh_alice')

  expect(await isAccountReaped(client, alice.address)).toBe(false)

  // Query initial total issuance
  const initialTotalIssuance = await client.api.query.balances.totalIssuance()

  const cumulativeFees = new Map<string, bigint>()

  // 2. Burn 999 ED

  const burnAmount = initialBalance - existentialDeposit
  const burnTx = client.api.tx.balances.burn(burnAmount, false)
  const burnEvents = await sendTransaction(burnTx.signAsync(alice))

  await client.dev.newBlock()

  await updateCumulativeFees(client.api, cumulativeFees, testConfig)

  await checkEvents(burnEvents, { section: 'balances', method: 'Burned' }).toMatchSnapshot('events for burn')

  // 3. Verify that the account is reaped

  expect(await isAccountReaped(client, alice.address)).toBe(true)

  const events = await client.api.query.system.events()
  const burnEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'Burned'
  })
  expect(burnEvent).toBeDefined()
  assert(client.api.events.balances.Burned.is(burnEvent!.event))
  const burnEventData = burnEvent!.event.data
  expect(burnEventData.who.toString()).toBe(encodeAddress(alice.address, testConfig.addressEncoding))
  expect(burnEventData.amount.toBigInt()).toBe(burnAmount)
  const dustLostEvent = events.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'DustLost'
  })
  expect(dustLostEvent).toBeDefined()
  assert(client.api.events.balances.DustLost.is(dustLostEvent!.event))
  const dustLostEventData = dustLostEvent!.event.data
  expect(dustLostEventData.account.toString()).toBe(encodeAddress(alice.address, testConfig.addressEncoding))
  const dustLostAmount = dustLostEventData.amount.toBigInt()

  // 4. Verify that the total issuance is decreased by the amount burned

  const totalIssuanceAfterBurn = await client.api.query.balances.totalIssuance()
  expect(totalIssuanceAfterBurn.toBigInt()).toBe(initialTotalIssuance.toBigInt() - (burnAmount + dustLostAmount))
}

/**
 * Test that burning with `keep_alive` set to `true` prevents burning below ED.
 *
 * 1. Create Alice with 1000 ED
 * 2. Attempt to burn 999 ED with `keep_alive` set to `true`
 * 3. Verify that the transaction fails
 * 4. Verify that Alice's balance only decreases by transaction fees
 * 5. Verify that total issuance is unchanged
 */
async function burnKeepAliveTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  // 1. Create Alice with 1000 ED

  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const initialBalance = existentialDeposit * 1000n
  const alice = await createAccountWithBalance(client, initialBalance, '//fresh_alice')

  expect(await isAccountReaped(client, alice.address)).toBe(false)

  // Query initial total issuance and Alice's initial balance
  const initialTotalIssuance = await client.api.query.balances.totalIssuance()
  const aliceAccountInitial = await client.api.query.system.account(alice.address)
  const aliceInitialBalance = aliceAccountInitial.data.free.toBigInt()

  const cumulativeFees = new Map<string, bigint>()

  // 2. Attempt to burn 999 ED with `keep_alive` set to `true`

  const burnAmount = existentialDeposit * 999n
  const burnTx = client.api.tx.balances.burn(burnAmount, true)
  await sendTransaction(burnTx.signAsync(alice))

  await client.dev.newBlock()

  await updateCumulativeFees(client.api, cumulativeFees, testConfig)

  // 3. Verify that the transaction fails

  const systemEvents = await client.api.query.system.events()
  const extrinsicFailedEvent = systemEvents.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })
  expect(extrinsicFailedEvent).toBeDefined()
  assert(client.api.events.system.ExtrinsicFailed.is(extrinsicFailedEvent!.event))

  const dispatchError = extrinsicFailedEvent!.event.data.dispatchError
  expect(dispatchError.isModule).toBe(false)
  expect(dispatchError.asToken.isFundsUnavailable).toBeTruthy()

  // 4. Verify that Alice's balance only decreases by transaction fees

  const aliceAccountAfter = await client.api.query.system.account(alice.address)
  const aliceFinalBalance = aliceAccountAfter.data.free.toBigInt()
  const transactionFee = cumulativeFees.get(encodeAddress(alice.address, testConfig.addressEncoding))!

  expect(aliceFinalBalance).toBe(aliceInitialBalance - transactionFee)
  expect(await isAccountReaped(client, alice.address)).toBe(false)

  // 5. Verify that total issuance is unchanged

  const finalTotalIssuance = await client.api.query.balances.totalIssuance()
  expect(finalTotalIssuance.toBigInt()).toBe(initialTotalIssuance.toBigInt())

  // Verify no Burned event was emitted
  const burnEvent = systemEvents.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'Burned'
  })
  expect(burnEvent).toBeUndefined()
}

/**
 * Test that burning funds from an account with a reserve cannot reap it due to nonzero consumer count.
 *
 * 1. Create Alice with 1000 ED + multisig deposit amount
 * 2. Create a multisig deposit to add a consumer reference
 * 3. Burn 999 ED with `keep_alive` set to `false`
 * 4. Verify that the account is NOT reaped due to consumer count
 * 5. Verify that total issuance is unchanged
 */
async function burnWithDepositTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  // 1. Create Alice with 1000 ED + multisig deposit amount

  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()

  const initialBalance = existentialDeposit * 2n
  const alice = await createAccountWithBalance(client, initialBalance, '//fresh_alice')

  expect(await isAccountReaped(client, alice.address)).toBe(false)

  // Query initial total issuance and consumer count
  const initialTotalIssuance = await client.api.query.balances.totalIssuance()
  const aliceAccountInitial = await client.api.query.system.account(alice.address)
  expect(aliceAccountInitial.consumers.toNumber()).toBe(0)

  const cumulativeFees = new Map<string, bigint>()

  // 2. Add a consumer reference

  const currentAccount = await client.api.query.system.account(alice.address)
  const currentFree = currentAccount.data.free.toBigInt()
  const currentReserved = currentAccount.data.reserved.toBigInt()
  const aliceNonce = (await client.api.rpc.system.accountNextIndex(alice.address)).toNumber()

  // Manually set account data to add a consumer reference.
  await client.dev.setStorage({
    System: {
      account: [
        [
          [alice.address],
          {
            nonce: aliceNonce,
            consumers: 1 + currentAccount.consumers.toNumber(),
            providers: currentAccount.providers.toNumber(),
            sufficients: currentAccount.sufficients.toNumber(),
            data: {
              free: currentFree,
              reserved: currentReserved,
              // No frozen balance required - to forestall the burn, only a consumer reference is needed.
              frozen: 0n,
              flags: currentAccount.data.flags,
            },
          },
        ],
      ],
    },
  })

  await client.dev.newBlock()

  // 3. Burn 1 ED with `keep_alive` set to `false`

  const burnAmount = existentialDeposit
  const burnTx = client.api.tx.balances.burn(burnAmount, false)
  await sendTransaction(burnTx.signAsync(alice))

  await client.dev.newBlock()

  await updateCumulativeFees(client.api, cumulativeFees, testConfig)

  // 4. Verify that the account is NOT reaped due to consumer count

  expect(await isAccountReaped(client, alice.address)).toBe(false)

  const aliceAccountAfterBurn = await client.api.query.system.account(alice.address)
  expect(aliceAccountAfterBurn.consumers.toNumber()).toBe(1) // Still has consumer
  expect(aliceAccountAfterBurn.data.frozen.toBigInt()).toBe(0n)

  // Verify the account has expected free balance (initial - fees)
  const totalFees = cumulativeFees.get(encodeAddress(alice.address, testConfig.addressEncoding))!
  const expectedFreeBalance = initialBalance - totalFees
  expect(aliceAccountAfterBurn.data.free.toBigInt()).toBe(expectedFreeBalance)

  // 5. Verify that total issuance is unchanged

  const finalTotalIssuance = await client.api.query.balances.totalIssuance()
  expect(finalTotalIssuance.toBigInt()).toBe(initialTotalIssuance.toBigInt())

  // Verify Burned event was not emitted
  const systemEvents = await client.api.query.system.events()
  const burnEvent = systemEvents.find((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'Burned'
  })
  expect(burnEvent).toBeUndefined()

  // Verify no KilledAccount event was emitted
  const killedEvent = systemEvents.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'KilledAccount'
  })
  expect(killedEvent).toBeUndefined()
}

/**
 * Test that attempting to burn all, or more than all, of an account's funds fails.
 *
 * 1. Create Alice with 100 ED
 * 2. Attempt to burn 100 ED - should fail due to insufficient funds
 * 3. Attempt to burn 100 ED again - should fail due to insufficient funds (balance is now < 100 ED due to fees)
 * 4. Verify Alice's balance only decreases by transaction fees
 * 5. Verify total issuance is unchanged in both cases
 */
async function burnDoubleAttemptTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  // 1. Create Alice with 100 ED

  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const initialBalance = existentialDeposit * 100n
  const alice = await createAccountWithBalance(client, initialBalance, '//fresh_alice')

  expect(await isAccountReaped(client, alice.address)).toBe(false)

  // Query initial total issuance and Alice's initial balance
  const initialTotalIssuance = await client.api.query.balances.totalIssuance()
  const aliceAccountInitial = await client.api.query.system.account(alice.address)
  const aliceInitialBalance = aliceAccountInitial.data.free.toBigInt()

  const cumulativeFees = new Map<string, bigint>()

  // 2. Attempt to burn 100 ED - should fail

  const burnAmount = existentialDeposit * 100n
  const firstBurnTx = client.api.tx.balances.burn(burnAmount, false)
  await sendTransaction(firstBurnTx.signAsync(alice))

  await client.dev.newBlock()

  await updateCumulativeFees(client.api, cumulativeFees, testConfig)

  // Verify first transaction failed
  let systemEvents = await client.api.query.system.events()
  let extrinsicFailedEvent = systemEvents.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })
  expect(extrinsicFailedEvent).toBeDefined()
  assert(client.api.events.system.ExtrinsicFailed.is(extrinsicFailedEvent!.event))

  let dispatchError = extrinsicFailedEvent!.event.data.dispatchError
  expect(dispatchError.isModule).toBe(false)
  expect(dispatchError.asToken.isFundsUnavailable).toBeTruthy()

  // 3. Attempt to burn 100 ED again - should fail due to insufficient funds

  const secondBurnTx = client.api.tx.balances.burn(burnAmount, false)
  await sendTransaction(secondBurnTx.signAsync(alice))

  await client.dev.newBlock()

  await updateCumulativeFees(client.api, cumulativeFees, testConfig)

  // Verify second transaction also failed
  systemEvents = await client.api.query.system.events()
  extrinsicFailedEvent = systemEvents.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })
  expect(extrinsicFailedEvent).toBeDefined()
  assert(client.api.events.system.ExtrinsicFailed.is(extrinsicFailedEvent!.event))

  dispatchError = extrinsicFailedEvent!.event.data.dispatchError
  expect(dispatchError.isModule).toBe(false)
  expect(dispatchError.asToken.isFundsUnavailable).toBeTruthy()

  // 4. Verify Alice's balance only decreases by transaction fees

  const aliceAccountAfter = await client.api.query.system.account(alice.address)
  const aliceFinalBalance = aliceAccountAfter.data.free.toBigInt()
  const transactionFees = cumulativeFees.get(encodeAddress(alice.address, testConfig.addressEncoding))!

  expect(aliceFinalBalance).toBe(aliceInitialBalance - transactionFees)
  expect(await isAccountReaped(client, alice.address)).toBe(false)

  // 5. Verify total issuance is unchanged

  const finalTotalIssuance = await client.api.query.balances.totalIssuance()
  expect(finalTotalIssuance.toBigInt()).toBe(initialTotalIssuance.toBigInt())

  // Verify no Burned events were emitted
  const burnEvents = systemEvents.filter((record) => {
    const { event } = record
    return event.section === 'balances' && event.method === 'Burned'
  })
  expect(burnEvents).toHaveLength(0)
}

// ---------------------------------------
// Various currency/fungible-related tests
// ---------------------------------------

/**
 * Helper function that tests liquidity restrictions for any deposit-requiring action.
 *
 * Some pallets are still using the `Currency` traits, which when combined with the new `Fungible` traits,
 * can lead to some operations failing incorrectly due to "liquidity restrictions".
 *
 * This test requires 3 actions:
 * 1. one that generates a reserve on a account for more than half its free balance
 * 2. one that generates a lock for more than half of its balance, again
 * 3. another action that internally uses `Currency::reserve` to reserve funds not exceeding the remaining free balance
 *
 * These actions (and tests) are generated at the test-tree level, so each network will have a different set of test
 * cases, depending on the pallets it has available, and whether it's been updated.
 * See the {@link DepositAction}, {@link ReserveAction}, and {@link LockAction} interfaces for more.
 *
 * Overall test structure:
 *
 * 1. Credit an account with 1_000_000 ED
 * 2. Execute the provided reserve action for 700_000 ED
 * 3. Execute the provided lock action for 700_000 ED
 * 4. Try to execute the provided deposit action
 * Depending on whether the runtime has been upstreamed a fix:
 * 5. Check that the transaction failed with the appropriate liquidity restriction error
 * 6. Verify that the account did, in fact, have enough funds to perform the operation
 * or
 * 5. Check that the transaction succeeded
 * 6. Verify that the deposit action placed the new expected reserve
 */
async function testLiquidityRestrictionForAction<
  TCustom extends Record<string, unknown>,
  TInitStorages extends Record<string, Record<string, any>>,
>(
  chain: Chain<TCustom, TInitStorages>,
  testConfig: TestConfig,
  reserveAction: ReserveAction<TCustom, TInitStorages>,
  lockAction: LockAction<TCustom, TInitStorages>,
  depositAction: DepositAction<TCustom, TInitStorages>,
  expectation: LiqRestrTestResExpectation,
) {
  const [client] = await setupNetworks(chain)

  // Skip test if any required pallet is not available
  const missingActions: string[] = []
  if (!reserveAction.isAvailable(client)) missingActions.push(`reserve=${reserveAction.name}`)
  if (!lockAction.isAvailable(client)) missingActions.push(`lock=${lockAction.name}`)
  if (!depositAction.isAvailable(client)) missingActions.push(`deposit=${depositAction.name}`)

  if (missingActions.length > 0) {
    await check(`Skipping test - required pallets not available: ${missingActions.join(', ')}`).toMatchSnapshot(
      'liquidity restriction test skipped',
    )
    return
  }

  // Step 1: Create account with 100_000 ED

  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const totalBalance = existentialDeposit * 1_000_000n
  const alice = testAccounts.alice

  // Set initial balance

  await client.dev.setStorage({
    System: {
      account: [[[alice.address], { providers: 1, data: { free: totalBalance } }]],
    },
  })

  // Initialize fee tracking map before any transactions
  const cumulativeFees = new Map<string, bigint>()
  await updateCumulativeFees(client.api, cumulativeFees, testConfig)

  // Step 2: Execute reserve action (e.g., create nomination pool, staking bond, or manual reserve)

  const reserveAmount = existentialDeposit * 700_000n
  const reservedAmount = await reserveAction.execute(client, alice, reserveAmount)

  await client.dev.newBlock()

  await updateCumulativeFees(client.api, cumulativeFees, testConfig)

  // Step 3: Execute lock action (e.g., vested transfer or manual lock)

  const lockAmount = existentialDeposit * 700_000n
  await lockAction.execute(client, alice, lockAmount, testConfig)

  await client.dev.newBlock()

  await updateCumulativeFees(client.api, cumulativeFees, testConfig)

  // Step 4: Try to execute the deposit action
  const actionTx = await depositAction.createTransaction(client)
  let actionEvents: any
  let rpcPaymentError = false

  try {
    actionEvents = await sendTransaction(actionTx.signAsync(alice))
  } catch (error: any) {
    // Handle Hydration-specific RPC error where payment validation fails before transaction submission
    // Error: RpcError: 1010: {"invalid":{"payment":null}}
    const errorMessage = error?.message || String(error)
    const errorCode = error?.code

    if (
      (errorCode === 1010 || errorMessage.includes('1010')) &&
      (errorMessage.includes('payment') || errorMessage.includes('invalid'))
    ) {
      rpcPaymentError = true
      // Transaction was rejected by the RPC before submission due to insufficient funds,
      // as expected due to liquidity restriction error.
    } else {
      throw error
    }
  }

  if (!rpcPaymentError) {
    await client.dev.newBlock()
    await updateCumulativeFees(client.api, cumulativeFees, testConfig)
  }

  // Step 5: Check the result of the transation

  // Step 6: Verify account state post action: in case of success, check new balances.

  // Reminder: If the chain has not been upgraded, expect the deposit action to fail, and verify accordingly.
  // If it has, the action should succeed.
  await match(expectation)
    .with('failure', async () => {
      // Step 5

      if (rpcPaymentError) {
        // For Hydration and similar chains, the RPC payment validation caught the insufficient funds
        // This is a pre-flight check that prevents the transaction from even being submitted
        await check('RPC payment validation rejected transaction due to insufficient funds').toMatchSnapshot('')
      } else {
        await checkEvents(actionEvents, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
          'liquidity restricted action events',
        )

        const finalEvents = await client.api.query.system.events()
        const failedEvent = finalEvents.find((record) => {
          const { event } = record
          return event.section === 'system' && event.method === 'ExtrinsicFailed'
        })

        expect(failedEvent).toBeDefined()
        assert(client.api.events.system.ExtrinsicFailed.is(failedEvent!.event))
        const dispatchError = failedEvent!.event.data.dispatchError

        assert(dispatchError.isModule)
        const moduleError = dispatchError.asModule
        expect(client.api.errors.balances.LiquidityRestrictions.is(moduleError)).toBe(true)
      }

      // Step 6

      const account = await client.api.query.system.account(alice.address)
      const actionDeposit = await depositAction.calculateDeposit(client)

      // If RPC payment error occurred, cumulative fees won't have been updated, so default to 0n
      const aliceFees = cumulativeFees.get(encodeAddress(alice.address, testConfig.addressEncoding)) || 0n

      expect(account.data.free.toBigInt()).toBe(totalBalance - lockAmount - aliceFees)
      expect(account.data.reserved.toBigInt()).toBe(reservedAmount)
      expect(account.data.frozen.toBigInt()).toBe(lockAmount)

      // The operation failed, even though the account had enough funds to place the required deposit
      expect(account.data.free.toBigInt()).toBeGreaterThanOrEqual(actionDeposit)
    })
    .with('success', async () => {
      // Step 5

      if (rpcPaymentError) {
        throw new Error(
          'RPC payment validation rejected transaction despite expectation="success". ' +
            'This chain may not have fixed the liquidity restriction bug yet. ' +
            'Set expectation="failure" in the test configuration.',
        )
      }

      await checkEvents(actionEvents, { section: 'balances', method: 'Reserved' }).toMatchSnapshot(
        'deposit action success events',
      )

      const finalEvents = await client.api.query.system.events()
      const reservedEvent = finalEvents.find((record) => {
        const { event } = record
        return event.section === 'balances' && event.method === 'Reserved'
      })
      expect(reservedEvent).toBeDefined()
      assert(client.api.events.balances.Reserved.is(reservedEvent!.event))
      const reservedEventData = reservedEvent!.event.data
      expect(reservedEventData.who.toString()).toBe(encodeAddress(alice.address, testConfig.addressEncoding))
      const actionDeposit = await depositAction.calculateDeposit(client)
      expect(reservedEventData.amount.toBigInt()).toBe(actionDeposit)

      // Step 6
      const account = await client.api.query.system.account(alice.address)

      expect(account.data.free.toBigInt()).toBe(
        totalBalance -
          lockAmount -
          actionDeposit -
          cumulativeFees.get(encodeAddress(alice.address, testConfig.addressEncoding))!,
      )
      expect(account.data.reserved.toBigInt()).toBe(reservedAmount + actionDeposit)
      expect(account.data.frozen.toBigInt()).toBe(lockAmount)
    })
    .exhaustive()
}

/// ----------
/// Test Trees
/// ----------

/**
 * Tests to `transfer_allow_death` that can run on any chain, regardless of the magnitude of its ED.
 */
const commonTransferAllowDeathTests = (chain: Chain, testConfig: TestConfig) => [
  {
    kind: 'test' as const,
    label: 'transfer of some funds does not kill sender account',
    testFn: () => transferAllowDeathNoKillTest(chain, testConfig),
  },
  {
    kind: 'test' as const,
    label: 'transfer below existential deposit fails',
    testFn: () => transferBelowExistentialDepositTest(chain, testConfig),
  },
  {
    kind: 'test' as const,
    label: 'transfer with insufficient funds fails',
    testFn: () => transferAllowDeathInsufficientFundsTest(chain, testConfig),
  },
  {
    kind: 'test' as const,
    label: 'self-transfer of entire balance',
    testFn: () => transferAllowDeathSelfTest(chain, testConfig),
  },
]

/**
 * Tests to `transfer_allow_death` that may require the chain's ED to be at least as large as the usual transaction
 * fee.
 */
const transferAllowDeathNormalEDTests = <
  TCustom extends Record<string, unknown>,
  TInitStoragesBase extends Record<string, Record<string, any>>,
>(
  chain: Chain<TCustom, TInitStoragesBase>,
  testConfig: TestConfig,
): RootTestTree => ({
  kind: 'describe',
  label: 'transfer_allow_death',
  children: [
    ...commonTransferAllowDeathTests(chain, testConfig),

    {
      kind: 'test',
      label: 'leaving an account below ED kills it',
      testFn: () => transferAllowDeathTest(chain, testConfig),
    },
    {
      kind: 'test',
      label: 'account with reserves is not reaped when transferring funds',
      testFn: () => transferAllowDeathWithReserveTest(chain, testConfig),
    },
  ],
})

/**
 * Tests to be run on chains with a relatively small ED (compared to the typical transaction fee).
 */
const transferAllowDeathLowEDTests = (chain: Chain, testConfig: TestConfig): RootTestTree => ({
  kind: 'describe',
  label: 'transfer_allow_death',
  children: commonTransferAllowDeathTests(chain, testConfig),
})

const commonTransferKeepAliveTests = (chain: Chain, testConfig: TestConfig) => [
  {
    kind: 'test' as const,
    label: 'transfer with insufficient funds fails',
    testFn: () => transferKeepAliveInsufficientFundsTest(chain, testConfig),
  },
  {
    kind: 'test' as const,
    label: 'self-transfer is a no-op',
    testFn: () => transferKeepAliveSelfTest(chain, testConfig),
  },
  {
    kind: 'test' as const,
    label: 'self-transfer with reasonable amount succeeds as no-op',
    testFn: () => transferKeepAliveSelfSuccessTest(chain, testConfig),
  },
]

const lowEdTransferKeepAliveTests = (chain: Chain, testConfig: TestConfig): RootTestTree => ({
  kind: 'describe',
  label: 'transfer_keep_alive',
  children: [
    ...commonTransferKeepAliveTests(chain, testConfig),
    {
      kind: 'test' as const,
      label: 'transfer (keep alive) below existential deposit fails on low ED chains',
      testFn: () => transferKeepAliveBelowEdLowEdTest(chain, testConfig),
    },
  ],
})

/**
 * Tests for `transfer_keep_alive` that require the chain's ED to be at least as large as the usual transaction fee.
 */
const transferKeepAliveNormalEDTests = (chain: Chain, testConfig: TestConfig): RootTestTree => ({
  kind: 'describe',
  label: 'transfer_keep_alive',
  children: [
    ...commonTransferKeepAliveTests(chain, testConfig),

    {
      kind: 'test',
      label: 'transfer (keep alive) below existential deposit fails',
      testFn: () => transferKeepAliveBelowEdTest(chain, testConfig),
    },
  ],
})

/**
 * Tests for `burn` that can run on any chain.
 */
const commonBurnTests = (chain: Chain, testConfig: TestConfig) => [
  {
    kind: 'test' as const,
    label: 'burning funds from account works',
    testFn: () => burnTestBaseCase(chain, testConfig),
  },
  {
    kind: 'test' as const,
    label: 'burning entire balance, or more than it, fails',
    testFn: () => burnDoubleAttemptTest(chain, testConfig),
  },
]

/**
 * Tests for `burn` on low ED chains.
 */
const burnLowEDTests = (chain: Chain, testConfig: TestConfig): RootTestTree => ({
  kind: 'describe',
  label: '`burn`',
  children: commonBurnTests(chain, testConfig),
})

/**
 * Tests for `burn` that require the chain's ED to be at least as large as the usual transaction fee.
 */
const burnNormalEDTests = (chain: Chain, testConfig: TestConfig): RootTestTree => ({
  kind: 'describe',
  label: '`burn`',
  children: [
    ...commonBurnTests(chain, testConfig),

    {
      kind: 'test',
      label: 'burning funds below ED leads to account reaping',
      testFn: () => burnTestWithReaping(chain, testConfig),
    },
    {
      kind: 'test' as const,
      label: 'burning below ED with keep_alive is no-op',
      testFn: () => burnKeepAliveTest(chain, testConfig),
    },
    {
      kind: 'test' as const,
      label: 'burning from account with multisig deposit cannot reap it',
      testFn: () => burnWithDepositTest(chain, testConfig),
    },
  ],
})

export const accountsE2ETests = <
  TCustom extends Record<string, unknown>,
  TInitStoragesBase extends Record<string, Record<string, any>>,
  TInitStoragesRelay extends Record<string, Record<string, any>>,
>(
  chain: Chain<TCustom, TInitStoragesBase>,
  testConfig: TestConfig,
  accountsCfg: AccountsTestConfig<TCustom, TInitStoragesBase, TInitStoragesRelay> = defaultAccountsTestConfig(),
): RootTestTree => ({
  kind: 'describe',
  label: testConfig.testSuiteName,
  children: [
    // `transfer_allow_death` tests
    match(testConfig.chainEd)
      .with('LowEd', () => transferAllowDeathLowEDTests(chain, testConfig))
      .with('Normal', () => transferAllowDeathNormalEDTests(chain, testConfig))
      .otherwise(() => transferAllowDeathNormalEDTests(chain, testConfig)),
    {
      kind: 'describe',
      label: '`force_transfer`',
      children: [
        {
          kind: 'test' as const,
          label: 'force transferring origin below ED can kill it',
          testFn: () => forceTransferKillTest(chain, testConfig, accountsCfg.relayChain),
        },
        {
          kind: 'test' as const,
          label: 'force transfer below existential deposit fails',
          testFn: () => forceTransferBelowExistentialDepositTest(chain, testConfig, accountsCfg.relayChain),
        },
        {
          kind: 'test' as const,
          label: 'force transfer with insufficient funds fails',
          testFn: () => forceTransferInsufficientFundsTest(chain, testConfig, accountsCfg.relayChain),
        },
        {
          kind: 'test',
          label: 'account with reserves cannot be force transferred from',
          testFn: () => forceTransferWithReserveTest(chain, testConfig, accountsCfg.relayChain),
        },
        {
          kind: 'test',
          label: 'non-root origins cannot force transfer',
          testFn: () => forceTransferBadOriginTest(chain),
        },
        {
          kind: 'test',
          label: 'self-transfer is a no-op',
          testFn: () => forceTransferSelfTest(chain, testConfig, accountsCfg.relayChain),
        },
      ],
    },
    // `transfer_keep_alive` tests
    match(testConfig.chainEd)
      .with('LowEd', () => lowEdTransferKeepAliveTests(chain, testConfig))
      .with('Normal', () => transferKeepAliveNormalEDTests(chain, testConfig))
      .otherwise(() => transferKeepAliveNormalEDTests(chain, testConfig)),
    {
      kind: 'describe',
      label: '`transfer_all`',
      children: [
        {
          kind: 'test',
          label: 'transfer all with keepAlive true leaves 1 ED',
          testFn: () => transferAllKeepAliveTrueTest(chain, testConfig),
        },
        {
          kind: 'test',
          label: 'transfer all with keepAlive false kills sender',
          testFn: () => transferAllKeepAliveFalseTest(chain, testConfig),
        },
        {
          kind: 'test',
          label: 'account with reserves cannot transfer all funds',
          testFn: () => transferAllWithReserveTest(chain, testConfig),
        },
        {
          kind: 'test',
          label: 'self-transfer all with keepAlive true is a no-op',
          testFn: () => transferAllSelfKeepAliveTrueTest(chain, testConfig),
        },
        {
          kind: 'test',
          label: 'self-transfer all with keepAlive false is a no-op',
          testFn: () => transferAllSelfKeepAliveFalseTest(chain, testConfig),
        },
      ],
    },
    {
      kind: 'describe',
      label: '`force_unreserve`',
      children: [
        {
          kind: 'test',
          label: 'non-root origins cannot forcefully unreserve',
          testFn: () => forceUnreserveBadOriginTest(chain),
        },
        {
          kind: 'test',
          label: 'unreserving 0 from account with no reserves is a no-op',
          testFn: () => forceUnreserveNoReservesTest(chain, testConfig, accountsCfg.relayChain),
        },
        {
          kind: 'test',
          label: 'unreserving from non-existent account is a no-op',
          testFn: () => forceUnreserveNonExistentAccountTest(chain, testConfig, accountsCfg.relayChain),
        },
        {
          kind: 'test',
          label: 'unreserving from account with reserves works correctly',
          testFn: () => forceUnreserveWithReservesTest(chain, testConfig, accountsCfg.relayChain),
        },
      ],
    },
    {
      kind: 'describe',
      label: '`force_set_balance`',
      children: [
        {
          kind: 'test',
          label: 'non-root origins cannot forcefully set balances',
          testFn: () => forceSetBalanceBadOriginTest(chain),
        },
        {
          kind: 'test',
          label: 'successfully sets balance and and adjusts total issuance',
          testFn: () => forceSetBalanceSuccessTest(chain, testConfig, accountsCfg.relayChain),
        },
        {
          kind: 'test',
          label: 'setting balance below ED reaps account and updates total issuance',
          testFn: () => forceSetBalanceBelowEdTest(chain, testConfig, accountsCfg.relayChain),
        },
      ],
    },
    {
      kind: 'describe',
      label: '`force_adjust_total_issuance`',
      children: [
        {
          kind: 'test',
          label: 'non-root origins cannot forcefully adjust the total issuance',
          testFn: () => forceAdjustTotalIssuanceBadOriginTest(chain),
        },
        {
          kind: 'test',
          label: 'zero delta fails with DeltaZero error in both directions',
          testFn: () => forceAdjustTotalIssuanceZeroDeltaTest(chain, testConfig, accountsCfg.relayChain),
        },
        {
          kind: 'test',
          label: 'successful adjustments increase and decrease total issuance',
          testFn: () => forceAdjustTotalIssuanceSuccessTest(chain, testConfig, accountsCfg.relayChain),
        },
      ],
    },
    // `burn` tests
    match(testConfig.chainEd)
      .with('LowEd', () => burnLowEDTests(chain, testConfig))
      .with('Normal', () => burnNormalEDTests(chain, testConfig))
      .otherwise(() => burnNormalEDTests(chain, testConfig)),
    {
      kind: 'describe',
      label: 'currency tests',
      children: (() => {
        const testCases: Array<{ kind: 'test'; label: string; testFn: () => Promise<void> }> = []

        if (!accountsCfg.actions) {
          throw new Error('accountsCfg.actions is required')
        }

        // Combinatorially generate test cases for as many combinations of reserves, locks and deposit actions that
        // trigger the liquidity restriction error.
        // If a network does not support any of the generated test cases, a log is shown, and the test is skipped.
        // At worst, this will require 3 roundtrips to the chopsticks local node; at best 1.
        for (const reserveAction of accountsCfg.actions.reserveActions!) {
          for (const lockAction of accountsCfg.actions.lockActions!) {
            for (const depositAction of accountsCfg.actions.depositActions!) {
              testCases.push({
                kind: 'test' as const,
                label: `liquidity restriction error: funds locked via ${reserveAction.name} and ${lockAction.name}, triggered via ${depositAction.name}`,
                testFn: () =>
                  testLiquidityRestrictionForAction(
                    chain,
                    testConfig,
                    reserveAction,
                    lockAction,
                    depositAction,
                    accountsCfg.expectation,
                  ),
              })
            }
          }
        }

        return testCases
      })(),
    },
  ],
})
