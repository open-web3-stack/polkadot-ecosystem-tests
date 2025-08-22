import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, defaultAccountsSr25519 } from '@e2e-test/networks'
import { type Client, type RootTestTree, setupNetworks } from '@e2e-test/shared'

import { assert, expect } from 'vitest'

/// -------
/// Helper Functions
/// -------

/**
 * Create a fresh account with specific balance above existential deposit
 */
async function createAccountWithBalance(client: Client<any, any>, balance: bigint, seed: string): Promise<any> {
  // Create fresh account from seed
  const newAccount = defaultAccountsSr25519.keyring.createFromUri(`//${seed}`)

  // Set account balance directly via storage
  await client.dev.setStorage({
    System: {
      account: [[[newAccount.address], { providers: 1, data: { free: balance } }]],
    },
  })

  return newAccount
}

/**
 * Check if account has been reaped (removed from storage)
 */
async function isAccountReaped(client: Client<any, any>, address: string): Promise<boolean> {
  const accountInfo = await client.api.query.system.account(address)
  // Account is reaped if it has no nonce, no providers, and zero balance
  return (
    accountInfo.nonce.toNumber() === 0 &&
    accountInfo.providers.toNumber() === 0 &&
    (accountInfo as any).data.free.toBigInt() === 0n
  )
}

/// -------
/// Test Functions
/// -------

/**
 * Test successful `transfer_allow_death`
 */
async function transferAllowDeathSuccessTest(chain: Chain) {
  const [client] = await setupNetworks(chain)

  // Create fresh accounts with sufficient balance
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const transferAmount = existentialDeposit * 100n
  const aliceBalance = transferAmount * 10n
  const alice = await createAccountWithBalance(client, aliceBalance, 'fresh_alice')
  const bob = await createAccountWithBalance(client, existentialDeposit, 'fresh_bob')

  const initialBobBalance = await client.api.query.system.account(bob.address)

  // Perform transfer
  const transferTx = client.api.tx.balances.transferAllowDeath(bob.address, transferAmount)
  await sendTransaction(transferTx.signAsync(alice))
  await client.dev.newBlock()

  // Verify balance changes (cannot check Transfer events due to mining rewards)
  const finalAliceBalance = await client.api.query.system.account(alice.address)
  const finalBobBalance = await client.api.query.system.account(bob.address)

  expect((finalAliceBalance as any).data.free.toBigInt()).toBe(aliceBalance - transferAmount)
  expect((finalBobBalance as any).data.free.toBigInt()).toBeGreaterThan((initialBobBalance as any).data.free.toBigInt())
}

/**
 * Test `transfer_allow_death` with insufficient balance
 */
async function transferAllowDeathInsufficientBalanceTest(chain: Chain) {
  const [client] = await setupNetworks(chain)

  // Create fresh accounts
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const aliceBalance = existentialDeposit * 2n
  const transferAmount = aliceBalance + 1000n // More than alice has
  const alice = await createAccountWithBalance(client, aliceBalance, 'fresh_alice')
  const bob = await createAccountWithBalance(client, existentialDeposit, 'fresh_bob')

  // Attempt transfer
  const transferTx = client.api.tx.balances.transferAllowDeath(bob.address, transferAmount)
  await sendTransaction(transferTx.signAsync(alice))
  await client.dev.newBlock()

  // Check for ExtrinsicFailed event
  const systemEvents = await client.api.query.system.events()
  const failedEvent = systemEvents.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  expect(failedEvent).toBeDefined()
  assert(client.api.events.system.ExtrinsicFailed.is(failedEvent!.event))
  const dispatchError = failedEvent!.event.data.dispatchError
  assert(dispatchError.isModule)
  assert(client.api.errors.balances.InsufficientBalance.is(dispatchError.asModule))
}

/**
 * Test `transfer_allow_death` with existential deposit violation
 */
async function transferAllowDeathExistentialDepositTest(chain: Chain) {
  const [client] = await setupNetworks(chain)
  const newAccount = defaultAccountsSr25519.keyring.createFromUri('//fresh_recipient')

  // Create alice with sufficient balance
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const aliceBalance = existentialDeposit * 100n
  const transferAmount = existentialDeposit - 1n // Below ED
  const alice = await createAccountWithBalance(client, aliceBalance, 'fresh_alice')

  // Attempt transfer below ED to new account
  const transferTx = client.api.tx.balances.transferAllowDeath(newAccount.address, transferAmount)
  await sendTransaction(transferTx.signAsync(alice))
  await client.dev.newBlock()

  // Check for ExtrinsicFailed event
  const systemEvents = await client.api.query.system.events()
  const failedEvent = systemEvents.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  expect(failedEvent).toBeDefined()
  assert(client.api.events.system.ExtrinsicFailed.is(failedEvent!.event))
  const dispatchError = failedEvent!.event.data.dispatchError
  assert(dispatchError.isModule)
  assert(client.api.errors.balances.ExistentialDeposit.is(dispatchError.asModule))
}

/**
 * Test that `transfer_allow_death` allows killing sender account
 */
async function transferAllowDeathKillAccountTest(chain: Chain) {
  const [client] = await setupNetworks(chain)

  // Create fresh accounts
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const initialAmount = existentialDeposit + 100n
  const testAccount = await createAccountWithBalance(client, initialAmount, 'fresh_alice')
  const bob = await createAccountWithBalance(client, existentialDeposit, 'fresh_bob')

  // Verify account exists before transfer
  expect(await isAccountReaped(client, testAccount.address)).toBe(false)

  // Transfer all balance away, killing the account
  const testAccountBalance = await client.api.query.system.account(testAccount.address)
  const transferAmount = (testAccountBalance as any).data.free.toBigInt()

  const transferTx = client.api.tx.balances.transferAllowDeath(bob.address, transferAmount)
  await sendTransaction(transferTx.signAsync(testAccount))
  await client.dev.newBlock()

  // Verify account was reaped
  expect(await isAccountReaped(client, testAccount.address)).toBe(true)
}

/**
 * Test successful `transfer_keep_alive`
 */
async function transferKeepAliveSuccessTest(chain: Chain) {
  const [client] = await setupNetworks(chain)

  // Create fresh accounts
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const transferAmount = existentialDeposit * 100n
  const aliceBalance = transferAmount * 10n
  const alice = await createAccountWithBalance(client, aliceBalance, 'fresh_alice')
  const bob = await createAccountWithBalance(client, existentialDeposit, 'fresh_bob')

  const transferTx = client.api.tx.balances.transferKeepAlive(bob.address, transferAmount)
  await sendTransaction(transferTx.signAsync(alice))
  await client.dev.newBlock()

  // Verify sender account still exists
  const aliceBalance2 = await client.api.query.system.account(alice.address)
  expect((aliceBalance2 as any).data.free.toBigInt()).toBeGreaterThanOrEqual(existentialDeposit)
}

/**
 * Test `transfer_keep_alive` with insufficient balance
 */
async function transferKeepAliveInsufficientBalanceTest(chain: Chain) {
  const [client] = await setupNetworks(chain)

  // Create fresh accounts
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const aliceBalance = existentialDeposit * 2n
  const transferAmount = aliceBalance + 1000n
  const alice = await createAccountWithBalance(client, aliceBalance, 'fresh_alice')
  const bob = await createAccountWithBalance(client, existentialDeposit, 'fresh_bob')

  const transferTx = client.api.tx.balances.transferKeepAlive(bob.address, transferAmount)
  await sendTransaction(transferTx.signAsync(alice))
  await client.dev.newBlock()

  const systemEvents = await client.api.query.system.events()
  const failedEvent = systemEvents.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  expect(failedEvent).toBeDefined()
  assert(client.api.events.system.ExtrinsicFailed.is(failedEvent!.event))
  const dispatchError = failedEvent!.event.data.dispatchError
  assert(dispatchError.isModule)
  assert(client.api.errors.balances.InsufficientBalance.is(dispatchError.asModule))
}

/**
 * Test `transfer_keep_alive` expendability protection
 */
async function transferKeepAliveExpendabilityTest(chain: Chain) {
  const [client] = await setupNetworks(chain)

  // Create fresh accounts
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const aliceBalance = existentialDeposit * 2n
  const alice = await createAccountWithBalance(client, aliceBalance, 'fresh_alice')
  const bob = await createAccountWithBalance(client, existentialDeposit, 'fresh_bob')

  // Try to transfer amount that would leave sender below existential deposit
  const transferAmount = aliceBalance - existentialDeposit + 1n

  const transferTx = client.api.tx.balances.transferKeepAlive(bob.address, transferAmount)
  await sendTransaction(transferTx.signAsync(alice))
  await client.dev.newBlock()

  const systemEvents = await client.api.query.system.events()
  const failedEvent = systemEvents.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  expect(failedEvent).toBeDefined()
  assert(client.api.events.system.ExtrinsicFailed.is(failedEvent!.event))
  const dispatchError = failedEvent!.event.data.dispatchError
  assert(dispatchError.isModule)
  assert(client.api.errors.balances.Expendability.is(dispatchError.asModule))
}

/**
 * Test `transfer_keep_alive` with existential deposit violation for recipient
 */
async function transferKeepAliveExistentialDepositTest(chain: Chain) {
  const [client] = await setupNetworks(chain)
  const newAccount = defaultAccountsSr25519.keyring.createFromUri('//new_account_keep_alive_ed_test')

  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const transferAmount = existentialDeposit - 1n
  const alice = await createAccountWithBalance(client, existentialDeposit * 100n, 'fresh_alice')

  const transferTx = client.api.tx.balances.transferKeepAlive(newAccount.address, transferAmount)
  await sendTransaction(transferTx.signAsync(alice))
  await client.dev.newBlock()

  const systemEvents = await client.api.query.system.events()
  const failedEvent = systemEvents.find((record) => {
    const { event } = record
    return event.section === 'system' && event.method === 'ExtrinsicFailed'
  })

  expect(failedEvent).toBeDefined()
  assert(client.api.events.system.ExtrinsicFailed.is(failedEvent!.event))
  const dispatchError = failedEvent!.event.data.dispatchError
  assert(dispatchError.isModule)
  assert(client.api.errors.balances.ExistentialDeposit.is(dispatchError.asModule))
}

/**
 * Test successful `transfer_all` with keep_alive=false (should kill sender)
 */
async function transferAllWithoutKeepAliveTest(chain: Chain) {
  const [client] = await setupNetworks(chain)

  // Create fresh accounts
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const initialAmount = existentialDeposit * 200n
  const testAccount = await createAccountWithBalance(client, initialAmount, 'fresh_alice_transfer_all')
  const bob = await createAccountWithBalance(client, existentialDeposit, 'fresh_bob_transfer_all')

  const transferAllTx = client.api.tx.balances.transferAll(bob.address, false)
  await sendTransaction(transferAllTx.signAsync(testAccount))
  await client.dev.newBlock()

  // Verify testAccount was reaped
  expect(await isAccountReaped(client, testAccount.address)).toBe(true)
}

/**
 * Test successful `transfer_all` with keep_alive=true (should leave ED)
 */
async function transferAllWithKeepAliveTest(chain: Chain) {
  const [client] = await setupNetworks(chain)

  // Create fresh accounts
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const initialAmount = existentialDeposit * 200n
  const testAccount = await createAccountWithBalance(client, initialAmount, 'fresh_alice_transfer_all_keep_alive')
  const bob = await createAccountWithBalance(client, existentialDeposit, 'fresh_bob_transfer_all_keep_alive')

  const transferAllTx = client.api.tx.balances.transferAll(bob.address, true)
  await sendTransaction(transferAllTx.signAsync(testAccount))
  await client.dev.newBlock()

  // Verify testAccount still exists and has at least ED
  expect(await isAccountReaped(client, testAccount.address)).toBe(false)
  const testAccountBalance = await client.api.query.system.account(testAccount.address)
  expect((testAccountBalance as any).data.free.toBigInt()).toBeGreaterThanOrEqual(existentialDeposit)
}

/**
 * Test `force_transfer` with bad origin (non-root)
 */
async function forceTransferBadOriginTest(chain: Chain) {
  const [client] = await setupNetworks(chain)

  // Create fresh accounts
  const existentialDeposit = client.api.consts.balances.existentialDeposit.toBigInt()
  const transferAmount = existentialDeposit * 100n
  const aliceBalance = transferAmount * 2n
  const alice = await createAccountWithBalance(client, aliceBalance, 'fresh_alice_force_transfer')
  const bob = await createAccountWithBalance(client, existentialDeposit, 'fresh_bob_force_transfer')

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

/// -------
/// Test Tree
/// -------

export const transferFunctionsTests = (
  chain: Chain,
  options: { testSuiteName: string; addressEncoding: number },
): RootTestTree => ({
  kind: 'describe',
  label: `${options.testSuiteName} - Transfer Functions`,
  children: [
    {
      kind: 'describe',
      label: '`transfer_allow_death`',
      children: [
        {
          kind: 'test',
          label: 'successful transfer_allow_death',
          testFn: () => transferAllowDeathSuccessTest(chain),
        },
        {
          kind: 'test',
          label: '`InsufficientBalance` error',
          testFn: () => transferAllowDeathInsufficientBalanceTest(chain),
        },
        {
          kind: 'test',
          label: '`ExistentialDeposit` error',
          testFn: () => transferAllowDeathExistentialDepositTest(chain),
        },
        {
          kind: 'test',
          label: 'should allow killing sender account',
          testFn: () => transferAllowDeathKillAccountTest(chain),
        },
      ],
    },
    {
      kind: 'describe',
      label: '`transfer_keep_alive`',
      children: [
        {
          kind: 'test',
          label: 'successful transfer_keep_alive',
          testFn: () => transferKeepAliveSuccessTest(chain),
        },
        {
          kind: 'test',
          label: '`InsufficientBalance` error',
          testFn: () => transferKeepAliveInsufficientBalanceTest(chain),
        },
        {
          kind: 'test',
          label: '`Expendability` error when would kill sender',
          testFn: () => transferKeepAliveExpendabilityTest(chain),
        },
        {
          kind: 'test',
          label: '`ExistentialDeposit` error',
          testFn: () => transferKeepAliveExistentialDepositTest(chain),
        },
      ],
    },
    {
      kind: 'describe',
      label: '`transfer_all`',
      children: [
        {
          kind: 'test',
          label: 'successful transfer_all with keep_alive=false',
          testFn: () => transferAllWithoutKeepAliveTest(chain),
        },
        {
          kind: 'test',
          label: 'successful transfer_all with keep_alive=true',
          testFn: () => transferAllWithKeepAliveTest(chain),
        },
      ],
    },
    {
      kind: 'describe',
      label: '`force_transfer`',
      children: [
        {
          kind: 'test',
          label: '`BadOrigin` error from non-root',
          testFn: () => forceTransferBadOriginTest(chain),
        },
      ],
    },
  ],
})
