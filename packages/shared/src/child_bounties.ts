import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, defaultAccountsSr25519 as devAccounts } from '@e2e-test/networks'
import { type Client, setupNetworks } from '@e2e-test/shared'

import { assert, expect } from 'vitest'

import { checkEvents, checkSystemEvents, scheduleInlineCallWithOrigin, TestConfig } from './helpers/index.js'
import type { RootTestTree } from './types.js'

/// -------
/// Helpers
/// -------

// multipliers for the bounty and curator fee
const BOUNTY_MULTIPLIER = 1000n
const CURATOR_FEE_MULTIPLIER = 100n

/**
 * Get the current bounty count
 */
async function getBountyCount(client: Client<any, any>): Promise<number> {
  return (await client.api.query.bounties.bountyCount()).toNumber()
}

/**
 * Get a bounty by index
 */
async function getBounty(client: Client<any, any>, bountyIndex: number): Promise<any | null> {
  const bounty = await client.api.query.bounties.bounties(bountyIndex)
  if (!bounty) return null
  return bounty.isSome ? bounty.unwrap() : null
}

/**
 * Get bounty description by index
 */
async function getBountyDescription(client: Client<any, any>, bountyIndex: number): Promise<string | null> {
  const description = await client.api.query.bounties.bountyDescriptions(bountyIndex)
  return description.isSome ? description.unwrap().toUtf8() : null
}

/**
 * Get approved bounties queue
 */
async function getBountyApprovals(client: Client<any, any>): Promise<number[]> {
  const approvals = await client.api.query.bounties.bountyApprovals()
  return approvals.map((index: any) => index.toNumber())
}

/**
 * Setup accounts with funds for testing
 */
async function setupTestAccounts(client: Client<any, any>, accounts: string[] = ['alice', 'bob', 'charlie']) {
  const accountMap = {
    alice: devAccounts.alice.address,
    bob: devAccounts.bob.address,
    charlie: devAccounts.charlie.address,
  }

  const accountData = accounts
    .filter((account) => accountMap[account as keyof typeof accountMap])
    .map((account) => [
      [accountMap[account as keyof typeof accountMap]],
      { providers: 1, data: { free: 100000000000000n } },
    ])

  await client.dev.setStorage({
    System: {
      account: accountData,
    },
  })
}

/**
 * Get bounty index from BountyProposed event
 */
async function getBountyIndexFromEvent(client: Client<any, any>): Promise<number> {
  const [bountyProposedEvent] = (await client.api.query.system.events()).filter(
    ({ event }: any) => event.section === 'bounties' && event.method === 'BountyProposed',
  )
  expect(bountyProposedEvent).toBeTruthy()
  assert(client.api.events.bounties.BountyProposed.is(bountyProposedEvent.event))
  return bountyProposedEvent.event.data.index.toNumber()
}

/**
 * Ensure the spend period is available
 */
async function ensureSpendPeriodAvailable(lastSpendPeriodBlock: any): Promise<boolean> {
  if (lastSpendPeriodBlock.isNone) {
    console.warn('Last spend period block is none, skipping test')
    return false
  }
  return true
}

/**
 * Get bounty events
 */
async function getBountyEvents(client: Client<any, any>): Promise<any[]> {
  return (await client.api.query.system.events()).filter((evt: any) => evt.event?.section === 'bounties')
}

/**
 * Get childBounties events
 */
async function getChildBountyEvents(client: Client<any, any>): Promise<any[]> {
  return (await client.api.query.system.events()).filter((evt: any) => evt.event?.section === 'childBounties')
}

/**
 *  Log the bounty events
 */
async function logBountyEvents(client: any) {
  const events = await getBountyEvents(client)
  events.forEach((evt: any, idx: number) => {
    console.log(`Event #${idx}:`, evt.event?.toHuman?.() ?? evt.event)
  })
}

/**
 * Log all events
 */
async function logAllEvents(client: any) {
  const events = await client.api.query.system.events()
  events.forEach((evt: any, idx: number) => {
    console.log(`Event #${idx}:`, evt.event?.toHuman?.() ?? evt.event)
  })
}

/**
 * Base set of childBounties end-to-end tests.
 *
 */
export function baseChildBountiesE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: { testSuiteName: string; addressEncoding: number }): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      {
        kind: 'test',
        label: 'child bounty creation test',
        testFn: async () => await childBountyCreationTest(chain),
      },
    ],
  }
}
