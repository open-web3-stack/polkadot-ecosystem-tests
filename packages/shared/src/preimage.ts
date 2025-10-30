import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, testAccounts } from '@e2e-test/networks'
import { type RootTestTree, setupNetworks } from '@e2e-test/shared'

import { assert, expect } from 'vitest'

import { checkEvents, scheduleInlineCallWithOrigin, type TestConfig } from './helpers/index.js'

/// -------
/// Helpers
/// -------

/**
 * Test the registering, querying and unregistering a preimage.
 *
 * 1. Alice registers (notes) a preimage for a treasury spend proposal.
 * 2. The preimage is queried to ensure it was stored correctly.
 * 3. Alice unregisters (unnotes) the preimage.
 * 4. The preimage is queried again to ensure it was removed.
 */
export async function preimageSingleNoteUnnoteTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  // 1. Alice registers (notes) a preimage for a treasury spend proposal.
  const encodedProposal = client.api.tx.treasury.spendLocal(1e10, testAccounts.bob.address).method
  const preimageTx = client.api.tx.preimage.notePreimage(encodedProposal.toHex())
  const preImageEvents = await sendTransaction(preimageTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  await checkEvents(preImageEvents, 'preimage').toMatchSnapshot('note preimage events')

  // 2. The preimage is queried to ensure it was stored correctly.
  let preimage = await client.api.query.preimage.preimageFor([
    encodedProposal.hash.toHex(),
    encodedProposal.encodedLength,
  ])

  assert(preimage.isSome)
  expect(preimage.unwrap().toHex()).toBe(encodedProposal.toHex())

  // 3. Alice (the same account) unregisters (unnotes) the preimage.
  const unnotePreimageTx = client.api.tx.preimage.unnotePreimage(encodedProposal.hash.toHex())
  const unnotePreImageEvents = await sendTransaction(unnotePreimageTx.signAsync(testAccounts.alice))

  await client.dev.newBlock()

  await checkEvents(unnotePreImageEvents, 'preimage').toMatchSnapshot('unnote preimage events')

  // 4. The preimage is queried again to ensure it was removed.
  preimage = await client.api.query.preimage.preimageFor([encodedProposal.hash.toHex(), encodedProposal.encodedLength])
  assert(preimage.isNone)
}

/**
 * Test the requesting and unrequesting of a preimage and its request status.
 *
 * 1. A root account requests a preimage for a treasury spend proposal.
 * 2. The request status is queried to ensure it is marked as "Requested".
 * 3. The root account unrequests the preimage.
 * 4. The request status is queried again to ensure the preimage hash was removed.
 */
export async function preimageSingleRequestUnrequestTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  // 1. A root account requests a preimage for a treasury spend proposal.
  const encodedProposal = client.api.tx.treasury.spendLocal(10e10, testAccounts.bob.address).method
  const proposalHash = encodedProposal.hash.toHex()
  const requestTx = client.api.tx.preimage.requestPreimage(proposalHash)

  await scheduleInlineCallWithOrigin(client, requestTx.method.toHex(), { system: 'Root' }, testConfig.blockProvider)
  await client.dev.newBlock()

  let status = await client.api.query.preimage.requestStatusFor(proposalHash)

  // 2. The request status is queried to ensure the preimage hash is marked as "Requested".
  assert(status.isSome)
  expect(status.unwrap().type).toBe('Requested')

  // 3. The root account unrequests the preimage.
  const unrequestTx = client.api.tx.preimage.unrequestPreimage(proposalHash)
  await scheduleInlineCallWithOrigin(client, unrequestTx.method.toHex(), { system: 'Root' }, testConfig.blockProvider)
  await client.dev.newBlock()

  // 4. The request status is queried again to ensure the preimage hash was removed.
  status = await client.api.query.preimage.requestStatusFor(proposalHash)
  assert(status.isNone)
}

/**
 * Test the requesting and multiple unrequesting of a preimage and its request status.
 *
 * 1. A root account requests a preimage for a treasury spend proposal.
 * 2. The request status is queried to ensure it is marked as "Requested".
 * 3. The root account unrequests the preimage multiple times.
 * 4. The request status is queried again to ensure the preimage hash was removed.
 */
export async function preimageSingleRequestMultipleUnrequestTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  // 1. A root account requests a preimage for a treasury spend proposal.
  const encodedProposal = client.api.tx.treasury.spendLocal(10e10, testAccounts.bob.address).method
  const proposalHash = encodedProposal.hash.toHex()
  const requestTx = client.api.tx.preimage.requestPreimage(proposalHash)

  await scheduleInlineCallWithOrigin(client, requestTx.method.toHex(), { system: 'Root' }, testConfig.blockProvider)
  await client.dev.newBlock()

  let status = await client.api.query.preimage.requestStatusFor(proposalHash)

  // 2. The request status is queried to ensure it is marked as "Requested".
  assert(status.isSome)
  expect(status.unwrap().type).toBe('Requested')

  // 3. The root account unrequests the preimage multiple times.
  const unrequestTx = client.api.tx.preimage.unrequestPreimage(proposalHash)
  await scheduleInlineCallWithOrigin(client, unrequestTx.method.toHex(), { system: 'Root' }, testConfig.blockProvider)
  await client.dev.newBlock()

  status = await client.api.query.preimage.requestStatusFor(proposalHash)
  assert(status.isNone)

  // Attempt to unrequest again.
  await scheduleInlineCallWithOrigin(client, unrequestTx.method.toHex(), { system: 'Root' }, testConfig.blockProvider)
  await client.dev.newBlock()

  status = await client.api.query.preimage.requestStatusFor(proposalHash)

  // 4. The second unrequest should be a no-op, and the status should remain None.
  assert(status.isNone)
}

/**
 * Test the requesting and unrequesting of a previously-registered preimage.
 *
 * 1. Alice registers (notes) a preimage for a treasury spend proposal.
 * 2. The request status is queried to ensure it is marked as "Unrequested".
 * 3. A root account requests the preimage.
 * 4. The request status is queried to ensure it is marked as "Requested".
 * 5. The root account unrequests the preimage.
 * 6. The request status is queried again to ensure it is marked as "Unrequested".
 * 7. Alice unregisters (unnotes) the preimage.
 * 8. The preimage is queried again to ensure it was removed.
 */
export async function preimageRequestAndNoteTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  // 1. Alice registers (notes) a preimage for a treasury spend proposal.
  const encodedProposal = client.api.tx.treasury.spendLocal(10e10, testAccounts.bob.address).method
  const proposalHash = encodedProposal.hash.toHex()

  let preimageTx = client.api.tx.preimage.notePreimage(encodedProposal.toHex())
  await sendTransaction(preimageTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()

  // Verify that the preimage was stored correctly.
  let preimage = await client.api.query.preimage.preimageFor([proposalHash, encodedProposal.encodedLength])

  assert(preimage.isSome)
  expect(preimage.unwrap().toHex()).toBe(encodedProposal.toHex())

  let status = await client.api.query.preimage.requestStatusFor(proposalHash)

  // 2. The request status is queried to ensure it is marked as "Unrequested".
  assert(status.isSome)
  expect(status.unwrap().type).toBe('Unrequested')

  // 3. A root account requests the preimage.
  const requestTx = client.api.tx.preimage.requestPreimage(proposalHash)
  await scheduleInlineCallWithOrigin(client, requestTx.method.toHex(), { system: 'Root' }, testConfig.blockProvider)
  await client.dev.newBlock()

  status = await client.api.query.preimage.requestStatusFor(proposalHash)

  // 4. The request status is queried to ensure it is marked as "Requested".
  assert(status.isSome)
  expect(status.unwrap().type).toBe('Requested')

  // 5. The root account unrequests the preimage.
  const unrequestTx = client.api.tx.preimage.unrequestPreimage(proposalHash)
  await scheduleInlineCallWithOrigin(client, unrequestTx.method.toHex(), { system: 'Root' }, testConfig.blockProvider)
  await client.dev.newBlock()

  // 6. The request status is queried again to ensure it is marked as "Unrequested".
  status = await client.api.query.preimage.requestStatusFor(proposalHash)
  assert(status.isSome)
  expect(status.unwrap().type).toBe('Unrequested')

  // 7. Alice unregisters (unnotes) the preimage.
  preimageTx = client.api.tx.preimage.unnotePreimage(proposalHash)
  await sendTransaction(preimageTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()

  // 8. The preimage is queried again to ensure it was removed.
  preimage = await client.api.query.preimage.preimageFor([proposalHash, encodedProposal.encodedLength])

  assert(preimage.isNone)
}

/**
 * Test the requesting and unrequesting of a preimage by a non-root user.
 *
 * 1. A standard account attempts unsuccessfully to request a preimage for a treasury spend proposal.
 * 2. The request status is queried to ensure it was not marked as "Requested".
 * 3. A root account requests the preimage.
 * 4. The request status is queried to ensure it is marked as "Requested".
 * 5. The standard account attempts unsuccessfully to unrequest the preimage.
 * 6. The request status is queried again to ensure it is still marked as "Requested".
 */
export async function preimageSingleRequestUnrequestAsNonRootTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig) {
  const [client] = await setupNetworks(chain)

  // 1. A standard account attempts unsuccessfully to request a preimage for a treasury spend proposal.
  const encodedProposal = client.api.tx.treasury.spendLocal(10e10, testAccounts.bob.address).method
  const requestTx = client.api.tx.preimage.requestPreimage(encodedProposal.hash.toHex())

  await sendTransaction(requestTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()

  let status = await client.api.query.preimage.requestStatusFor(encodedProposal.hash.toHex())

  // 2. The request status is queried to ensure it was not marked as "Requested".
  assert(status.isNone)

  // 3. A root account requests the preimage.
  await scheduleInlineCallWithOrigin(client, requestTx.method.toHex(), { system: 'Root' }, testConfig.blockProvider)
  await client.dev.newBlock()

  status = await client.api.query.preimage.requestStatusFor(encodedProposal.hash.toHex())

  // 4. The request status is queried to ensure it is marked as "Requested".
  assert(status.isSome)
  expect(status.unwrap().type).toBe('Requested')

  // 5. The standard account attempts unsuccessfully to unrequest the preimage.
  const unrequestTx = client.api.tx.preimage.unrequestPreimage(encodedProposal.hash.toHex())

  await sendTransaction(unrequestTx.signAsync(testAccounts.alice))
  await client.dev.newBlock()

  status = await client.api.query.preimage.requestStatusFor(encodedProposal.hash.toHex())

  // 6. The request status is queried again to ensure it is still marked as "Requested".
  assert(status.isSome)
  expect(status.unwrap().type).toBe('Requested')
}

export function successPreimageE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      {
        kind: 'describe',
        label: 'preimage tests',
        children: [
          {
            kind: 'test',
            label: 'preimage single note and unnote test',
            testFn: async () => await preimageSingleNoteUnnoteTest(chain),
          },
          {
            kind: 'test',
            label: 'preimage single request and unrequest test',
            testFn: async () => await preimageSingleRequestUnrequestTest(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'preimage single request and multiple unrequest test',
            testFn: async () => await preimageSingleRequestMultipleUnrequestTest(chain, testConfig),
          },
          {
            kind: 'test',
            label: 'preimage request and note test',
            testFn: async () => await preimageRequestAndNoteTest(chain, testConfig),
          },
        ],
      },
    ],
  }
}

export function failurePreimageE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: 'failure tests',
    children: [
      {
        kind: 'test',
        label: 'preimage single request and unrequest test as non-root',
        testFn: async () => await preimageSingleRequestUnrequestAsNonRootTest(chain, testConfig),
      },
    ],
  }
}

export function basePreimageE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [successPreimageE2ETests(chain, testConfig), failurePreimageE2ETests(chain, testConfig)],
  }
}
