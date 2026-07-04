#!/usr/bin/env npx tsx

/**
 * Hollar Salary Migration Validation
 *
 * This script validates the Fellowship salary payout flow after migration from USDT to Hollar.
 * It seeds test members at each rank (1-9) and verifies they receive correct Hollar amounts
 * via XCM from the Fellowship Salary sovereign account on Asset Hub.
 *
 * Key migration requirement discovered: Hollar is `isSufficient: false` on Asset Hub,
 * meaning recipients MUST have a DOT balance (existential deposit) to receive Hollar.
 * Members without DOT will have their XCM transfer fail silently.
 *
 * The script demonstrates both success (with DOT) and failure (without DOT) cases.
 *
 * Usage:
 *   LOG_LEVEL=warn npx tsx scripts/hollar-migration/validate-hollar-transition.ts
 */

import { sendTransaction } from '@acala-network/chopsticks-testing'

import { createNetworks } from '@e2e-test/networks'
import { assetHubPolkadot, collectivesPolkadot } from '@e2e-test/networks/chains'

import { Keyring } from '@polkadot/keyring'

/// -----------
/// Constants
/// -----------

/**
 * Hollar asset location from Asset Hub's perspective.
 * Hollar lives on Hydration (parachain 2034) with GeneralIndex 222.
 */
const HOLLAR_LOCATION = {
  parents: 1,
  interior: { X2: [{ Parachain: 2034 }, { GeneralIndex: 222 }] },
}

/**
 * Asset Hub location from Collectives' perspective.
 * Both are sibling parachains, so we go up to relay (parents: 1) then down to parachain 1000.
 */
const ASSET_HUB_LOCATION = { parents: 1, interior: { X1: [{ Parachain: 1000 }] } }

/**
 * Fellowship Salary pallet's sovereign account on Asset Hub.
 * Derived from the pallet's location on Collectives; holds salary funds.
 */
const SALARY_SOVEREIGN = '13w7NdvSR1Af8xsQTArDtZmVvjE8XhWNdL4yed3iFHrUNCnS'

const HOLLAR_DECIMALS = 18
const HOLLAR_UNITS = 10n ** BigInt(HOLLAR_DECIMALS)

/** Proposed budget from the migration referendum. */
const HOLLAR_BUDGET = 400_000n * HOLLAR_UNITS

/**
 * Post-migration active salaries by rank (index 0 = rank 1).
 * Monthly salaries for active fellowship members in raw Hollar units (18 decimals).
 *
 * | Rank | Hollar/month |
 * |------|--------------|
 * | 1    | 833.33       |
 * | 2    | 1,666.66     |
 * | 3    | 6,666.66     |
 * | 4    | 10,000       |
 * | 5    | 13,333.33    |
 * | 6-9  | 16,666.66    |
 */
const HOLLAR_ACTIVE_SALARY = [
  833_333_333_333_333_333_333n,
  1_666_666_666_666_666_666_666n,
  6_666_666_666_666_666_666_666n,
  10_000_000_000_000_000_000_000n,
  13_333_333_333_333_333_333_333n,
  16_666_666_666_666_666_666_666n,
  16_666_666_666_666_666_666_666n,
  16_666_666_666_666_666_666_666n,
  16_666_666_666_666_666_666_666n,
]

/** Passive salaries: 50% of active for ranks 1-5, then matches active for 6-9. */
const HOLLAR_PASSIVE_SALARY = [
  416_666_666_666_666_666_666n,
  833_333_333_333_333_333_333n,
  3_333_333_333_333_333_333_333n,
  5_000_000_000_000_000_000_000n,
  6_666_666_666_666_666_666_666n,
  8_333_333_333_333_333_333_333n,
  8_333_333_333_333_333_333_333n,
  8_333_333_333_333_333_333_333n,
  8_333_333_333_333_333_333_333n,
]

/**
 * Current fellowship member counts per rank (as of 2026-07-03).
 * Index 0 = rank 1. Derived from cumulative memberCount (55, 35, 21, 11, 5, 2, 1, 0, 0).
 */
const MEMBERS_PER_RANK = [20, 14, 10, 6, 3, 1, 1, 0, 0]
const MAX_RANK = MEMBERS_PER_RANK.length

/// ---------
/// Helpers
/// ---------

/** Format raw Hollar (18 decimals) as human-readable string: e.g., 833_333...333n → "833.33" */
function formatHollar(raw: bigint): string {
  const whole = raw / HOLLAR_UNITS
  const frac = raw % HOLLAR_UNITS
  if (frac === 0n) return whole.toLocaleString()
  const fracStr = frac.toString().padStart(HOLLAR_DECIMALS, '0').slice(0, 2)
  return `${whole.toLocaleString()}.${fracStr}`
}

/** Query ForeignAssets.account for Hollar balance on Asset Hub. */
async function hollarBalance(api: any, address: string): Promise<bigint> {
  const bal = await api.query.foreignAssets.account(HOLLAR_LOCATION, address)
  return bal.isSome ? BigInt(bal.unwrap().balance.toString()) : 0n
}

async function currentBlock(client: any): Promise<number> {
  return (await client.api.rpc.chain.getHeader()).number.toNumber()
}

/// -------
/// Types
/// -------

interface TestMember {
  signer: ReturnType<Keyring['addFromUri']>
  rank: number
  expectedSalary: bigint
  /** If false, member has no DOT on Asset Hub → XCM transfer will fail. */
  hasDotOnAH: boolean
}

/// ------
/// Main
/// ------

/**
 * Validate the full Fellowship salary payout flow with Hollar as the salary asset.
 *
 * Phase 1 — demonstrate isSufficient: false problem:
 * 1. Verify Hollar exists on Asset Hub and check isSufficient
 * 2. Seed sovereign Hollar balance; give DOT to all members EXCEPT 1 per rank
 * 3. Set salary asset to Hollar via Parameters.parameters on Collectives
 * 4. Seed test members on Collectives (real distribution, ranks 1-7)
 * 5. Bump → register → payout cycle
 * 6. Verify members with DOT received Hollar; members without DOT got nothing
 * 7. Verify treasury integrity
 *
 * Phase 2 — fix with forceAssetStatus:
 * 8. Call foreignAssets.forceAssetStatus to set isSufficient: true
 * 9. Re-run the salary cycle for the previously-failed members (no DOT)
 * 10. Verify they now receive Hollar without needing DOT
 */
async function main() {
  console.log('=== Hollar Salary Migration Validation ===\n')

  const [collectivesClient, assetHubClient] = await createNetworks(collectivesPolkadot, assetHubPolkadot)
  const cApi = collectivesClient.api
  const ahApi = assetHubClient.api

  try {
    const registrationPeriod = Number(cApi.consts.fellowshipSalary.registrationPeriod.toString())
    const payoutPeriod = Number(cApi.consts.fellowshipSalary.payoutPeriod.toString())
    const cyclePeriod = registrationPeriod + payoutPeriod

    const keyring = new Keyring({ type: 'sr25519' })
    const members: TestMember[] = []

    for (let rank = 1; rank <= MAX_RANK; rank++) {
      const count = MEMBERS_PER_RANK[rank - 1]
      for (let i = 0; i < count; i++) {
        members.push({
          signer: keyring.addFromUri(`//hollar_test_r${rank}_${i}`),
          rank,
          expectedSalary: HOLLAR_ACTIVE_SALARY[rank - 1],
          hasDotOnAH: count === 1 || i !== 0,
        })
      }
    }

    const activeRanks = MEMBERS_PER_RANK.filter((c) => c > 0).length
    const withDot = members.filter((m) => m.hasDotOnAH).length
    const withoutDot = members.filter((m) => !m.hasDotOnAH).length
    console.log(`Test members: ${members.length} (real distribution across ${activeRanks} ranks)`)
    for (let rank = 1; rank <= MAX_RANK; rank++) {
      if (MEMBERS_PER_RANK[rank - 1] > 0) console.log(`  Rank ${rank}: ${MEMBERS_PER_RANK[rank - 1]} members`)
    }
    console.log(`  With DOT on AH: ${withDot}`)
    console.log(`  Without DOT:    ${withoutDot} (1 per active rank - expect XCM failure)`)

    // 1. Verify Hollar exists on Asset Hub (bridged from Hydration)
    console.log('\n--- 1. Checking Hollar on Asset Hub ---')
    const assetMetadata = await ahApi.query.foreignAssets.asset(HOLLAR_LOCATION)
    if (!assetMetadata.isSome) throw new Error('Hollar not found on Asset Hub - bridge from Hydration first')
    const assetInfo = assetMetadata.unwrap()
    const hollarIsSufficient = assetInfo.isSufficient.isTrue
    console.log(`  isSufficient: ${hollarIsSufficient ? 'YES' : 'NO (recipients need DOT for ED)'}`)

    // 2. Seed sovereign Hollar balance + DOT for test members who should succeed
    console.log('\n--- 2. Seeding Asset Hub ---')
    const totalExpectedPayout = members.reduce((sum, m) => sum + m.expectedSalary, 0n)
    const ahStorageUpdates: any = {
      ForeignAssets: {
        asset: [
          [
            [HOLLAR_LOCATION],
            {
              ...assetInfo.toJSON(),
              accounts: assetInfo.accounts.toNumber() + members.length + 1,
              supply: (BigInt(assetInfo.supply.toString()) + totalExpectedPayout * 2n).toString(),
            },
          ],
        ],
        account: [[[HOLLAR_LOCATION, SALARY_SOVEREIGN], { balance: (totalExpectedPayout * 2n).toString() }]],
      },
    }

    if (!hollarIsSufficient) {
      const ED = 10n ** 10n
      const membersWithDot = members.filter((m) => m.hasDotOnAH)
      ahStorageUpdates.System = {
        account: membersWithDot.map((m) => [
          [m.signer.address],
          { providers: 1, data: { free: ED.toString(), frozen: 0, reserved: 0 } },
        ]),
      }
    }
    await assetHubClient.dev.setStorage(ahStorageUpdates)
    console.log(`  Sovereign Hollar: ${formatHollar(totalExpectedPayout * 2n)}`)
    if (!hollarIsSufficient) {
      console.log(`  DOT seeded: ${withDot} members`)
      console.log(`  DOT skipped: ${withoutDot} members (will fail)`)
    }

    // 3. Set salary asset to Hollar via Parameters storage
    console.log('\n--- 3. Setting salary config to Hollar ---')
    await collectivesClient.dev.setStorage({
      Parameters: {
        parameters: [
          [
            [{ FellowshipSalary: 'SalaryConfig' }],
            {
              FellowshipSalary: {
                SalaryConfig: {
                  asset: { V5: { location: ASSET_HUB_LOCATION, assetId: HOLLAR_LOCATION } },
                  budget: HOLLAR_BUDGET.toString(),
                },
              },
            },
          ],
        ],
      },
    })
    console.log(`  Asset: Hollar (Hydration parachain 2034)`)
    console.log(`  Budget: ${formatHollar(HOLLAR_BUDGET)}`)

    // 4. Seed test members on Collectives with collective membership + claimant state
    console.log('\n--- 4. Seeding test members on Collectives ---')
    const block = await currentBlock(collectivesClient)
    await collectivesClient.dev.setStorage({
      System: {
        account: members.map((m) => [
          [m.signer.address],
          { providers: 1, data: { free: (100n * 10n ** 10n).toString(), frozen: 0, reserved: 0 } },
        ]),
      },
      FellowshipCollective: {
        members: members.map((m) => [[m.signer.address], { rank: m.rank }]),
      },
      FellowshipCore: {
        member: members.map((m) => [[m.signer.address], { isActive: true, lastPromotion: 0, lastProof: 0 }]),
        params: {
          activeSalary: HOLLAR_ACTIVE_SALARY.map((s) => s.toString()),
          passiveSalary: HOLLAR_PASSIVE_SALARY.map((s) => s.toString()),
          demotionPeriod: [657450, 657450, 1314900, 1314900, 2629800, 2629800, 3944700, 5259600, 7889400],
          minPromotionPeriod: [657450, 657450, 1314900, 1314900, 2629800, 2629800, 3944700, 5259600, 7889400],
          offboardTimeout: 657450,
        },
      },
      FellowshipSalary: {
        claimant: members.map((m) => [[m.signer.address], { lastActive: 99, status: { nothing: null } }]),
        status: {
          cycleIndex: 100,
          cycleStart: block - cyclePeriod - 1,
          budget: HOLLAR_BUDGET.toString(),
          totalRegistrations: '0',
          totalUnregisteredPaid: '0',
        },
      },
    })
    console.log(`  Seeded ${members.length} members (ranks 1-${MAX_RANK})`)

    // 5. Bump to a new salary cycle
    console.log('\n--- 5. Bumping to next cycle ---')
    await sendTransaction(cApi.tx.fellowshipSalary.bump().signAsync(members[0].signer))
    await collectivesClient.dev.newBlock()
    const statusAfterBump = (await cApi.query.fellowshipSalary.status()).toJSON() as any
    console.log(`  Cycle: ${statusAfterBump.cycleIndex}`)

    // 6. Register all members for salary
    console.log('\n--- 6. Registering all members ---')
    for (const m of members) {
      await sendTransaction(cApi.tx.fellowshipSalary.register().signAsync(m.signer))
    }
    await collectivesClient.dev.newBlock()
    const statusAfterReg = (await cApi.query.fellowshipSalary.status()).toJSON() as any
    console.log(`  Total registered: ${formatHollar(BigInt(statusAfterReg.totalRegistrations))} Hollar`)

    // 7. Advance to payout window, then call payout for all members
    const sovBalBefore = await hollarBalance(ahApi, SALARY_SOVEREIGN)
    console.log('\n--- 7. Paying out all members ---')
    const blockNow = await currentBlock(collectivesClient)
    await collectivesClient.dev.setStorage({
      FellowshipSalary: {
        status: {
          ...statusAfterReg,
          cycleStart: blockNow - registrationPeriod - 1,
        },
      },
    })

    for (const m of members) {
      await sendTransaction(cApi.tx.fellowshipSalary.payout().signAsync(m.signer))
    }
    await collectivesClient.dev.newBlock()
    await assetHubClient.dev.newBlock()

    // 8. Verify members WITH DOT received correct Hollar amount for their rank
    //    When totalRegistrations > budget, payouts are prorated: (salary * budget) / totalRegistrations
    const totalRegistrations = BigInt(statusAfterReg.totalRegistrations)
    const prorated = totalRegistrations > HOLLAR_BUDGET
    if (prorated) {
      console.log(
        `\n  ⚠ Budget oversubscribed: ${formatHollar(totalRegistrations)} registered vs ${formatHollar(HOLLAR_BUDGET)} budget`,
      )
      console.log(`    Payouts will be prorated to ${Number((HOLLAR_BUDGET * 10000n) / totalRegistrations) / 100}%`)
    }

    console.log('\n=== 8. Results: Members WITH DOT ===')
    let passCount = 0

    for (let rank = 1; rank <= MAX_RANK; rank++) {
      const rankMembersWithDot = members.filter((m) => m.rank === rank && m.hasDotOnAH)
      if (rankMembersWithDot.length === 0) continue
      const fullSalary = HOLLAR_ACTIVE_SALARY[rank - 1]
      const expected = prorated ? (fullSalary * HOLLAR_BUDGET) / totalRegistrations : fullSalary
      let allPass = true

      for (const m of rankMembersWithDot) {
        const received = await hollarBalance(ahApi, m.signer.address)
        const diff = received > expected ? received - expected : expected - received
        if (diff > HOLLAR_UNITS / 100n) allPass = false
      }

      const sampleReceived = await hollarBalance(ahApi, rankMembersWithDot[0].signer.address)
      if (allPass) passCount++

      const label = prorated
        ? `${formatHollar(sampleReceived)} / ${formatHollar(expected)} (prorated from ${formatHollar(fullSalary)})`
        : `${formatHollar(sampleReceived)} / ${formatHollar(expected)}`
      console.log(`  Rank ${rank}: ${label} ${allPass ? '✓' : '✗'}`)
    }

    // 9. Verify members WITHOUT DOT received nothing (XCM failed silently)
    console.log('\n=== 9. Results: Members WITHOUT DOT ===')
    let noDotFailures = 0

    for (let rank = 1; rank <= MAX_RANK; rank++) {
      const noDotMember = members.find((m) => m.rank === rank && !m.hasDotOnAH)
      if (!noDotMember) continue
      const expected = HOLLAR_ACTIVE_SALARY[rank - 1]
      const received = await hollarBalance(ahApi, noDotMember.signer.address)

      const failed = received === 0n
      if (failed) noDotFailures++

      console.log(
        `  Rank ${rank}: ${formatHollar(received)} / ${formatHollar(expected)} ${failed ? '✗ (XCM failed)' : '✓'}`,
      )
    }

    // 10. Verify sovereign balance: failed payouts did not drain the treasury
    const sovBalAfter = await hollarBalance(ahApi, SALARY_SOVEREIGN)
    const expectedDrain = members
      .filter((m) => m.hasDotOnAH)
      .reduce((sum, m) => {
        const salary = prorated ? (m.expectedSalary * HOLLAR_BUDGET) / totalRegistrations : m.expectedSalary
        return sum + salary
      }, 0n)
    const actualDrain = sovBalBefore - sovBalAfter
    const drainDiff = actualDrain > expectedDrain ? actualDrain - expectedDrain : expectedDrain - actualDrain
    const treasuryCorrect = drainDiff <= (HOLLAR_UNITS / 100n) * BigInt(members.filter((m) => m.hasDotOnAH).length)

    console.log('\n=== 10. Treasury integrity ===')
    console.log(`  Sovereign before: ${formatHollar(sovBalBefore)}`)
    console.log(`  Sovereign after:  ${formatHollar(sovBalAfter)}`)
    console.log(
      `  Drained:          ${formatHollar(actualDrain)} (expected ${formatHollar(expectedDrain)}) ${treasuryCorrect ? '✓' : '✗'}`,
    )

    const ranksWithNoDotMembers = MEMBERS_PER_RANK.filter((c) => c > 1).length

    console.log('\n=== Summary ===')
    console.log(`  With DOT:    ${passCount}/${activeRanks} ranks received correct Hollar`)
    console.log(`  Without DOT: ${noDotFailures}/${ranksWithNoDotMembers} ranks failed (expected - no ED)`)
    console.log(
      `  Treasury:    ${treasuryCorrect ? 'correct - failed payouts not drained' : 'WRONG - unexpected drain'}`,
    )

    const phase1Pass = passCount === activeRanks && noDotFailures === ranksWithNoDotMembers && treasuryCorrect
    console.log(
      `\nPhase 1 ${phase1Pass ? 'PASS' : 'FAIL'}: Hollar transfers succeed with DOT, fail without, treasury intact`,
    )
    if (!phase1Pass) {
      process.exitCode = 1
      return
    }

    // =========================================================================
    // Phase 2: Fix with forceAssetStatus → isSufficient: true
    // =========================================================================

    // 8. Simulate forceAssetStatus(isSufficient: true) — the proposed referendum call
    console.log('\n--- 8. Making Hollar isSufficient (simulating forceAssetStatus) ---')
    const currentAsset = (await ahApi.query.foreignAssets.asset(HOLLAR_LOCATION)).unwrap()
    await assetHubClient.dev.setStorage({
      ForeignAssets: {
        asset: [
          [
            [HOLLAR_LOCATION],
            {
              ...currentAsset.toJSON(),
              isSufficient: true,
            },
          ],
        ],
      },
    })

    const updatedAsset = (await ahApi.query.foreignAssets.asset(HOLLAR_LOCATION)).unwrap()
    console.log(`  isSufficient: ${updatedAsset.isSufficient.isTrue ? 'YES ✓' : 'NO ✗ (fix failed)'}`)
    if (!updatedAsset.isSufficient.isTrue) {
      console.log('\nFAIL: could not set isSufficient')
      process.exitCode = 1
      return
    }
    console.log('  (In production: foreignAssets.forceAssetStatus via relay XCM referendum)')

    // 9. Re-run salary cycle for the no-DOT members
    console.log('\n--- 9. Re-running salary cycle for previously-failed members ---')
    const noDotMembers = members.filter((m) => !m.hasDotOnAH)

    const block2 = await currentBlock(collectivesClient)
    await collectivesClient.dev.setStorage({
      FellowshipSalary: {
        claimant: noDotMembers.map((m) => [
          [m.signer.address],
          { lastActive: statusAfterBump.cycleIndex, status: { nothing: null } },
        ]),
        status: {
          cycleIndex: statusAfterBump.cycleIndex + 1,
          cycleStart: block2 - cyclePeriod - 1,
          budget: HOLLAR_BUDGET.toString(),
          totalRegistrations: '0',
          totalUnregisteredPaid: '0',
        },
      },
    })

    await sendTransaction(cApi.tx.fellowshipSalary.bump().signAsync(noDotMembers[0].signer))
    await collectivesClient.dev.newBlock()

    for (const m of noDotMembers) {
      await sendTransaction(cApi.tx.fellowshipSalary.register().signAsync(m.signer))
    }
    await collectivesClient.dev.newBlock()

    const block3 = await currentBlock(collectivesClient)
    const statusPhase2 = (await cApi.query.fellowshipSalary.status()).toJSON() as any
    await collectivesClient.dev.setStorage({
      FellowshipSalary: {
        status: { ...statusPhase2, cycleStart: block3 - registrationPeriod - 1 },
      },
    })

    for (const m of noDotMembers) {
      await sendTransaction(cApi.tx.fellowshipSalary.payout().signAsync(m.signer))
    }
    await collectivesClient.dev.newBlock()
    await assetHubClient.dev.newBlock()

    // 10. Verify previously-failed members now received Hollar without DOT
    console.log('\n=== 10. Results: Previously-failed members (no DOT, now sufficient) ===')
    let phase2PassCount = 0

    for (let rank = 1; rank <= MAX_RANK; rank++) {
      const noDotMember = noDotMembers.find((m) => m.rank === rank)
      if (!noDotMember) continue
      const expected = HOLLAR_ACTIVE_SALARY[rank - 1]
      const received = await hollarBalance(ahApi, noDotMember.signer.address)
      const diff = received > expected ? received - expected : expected - received
      const pass = diff <= HOLLAR_UNITS / 100n
      if (pass) phase2PassCount++

      console.log(`  Rank ${rank}: ${formatHollar(received)} / ${formatHollar(expected)} ${pass ? '✓' : '✗'}`)
    }

    console.log('\n=== Final Summary ===')
    console.log(`  Phase 1: ${phase1Pass ? 'PASS' : 'FAIL'} — isSufficient: false blocks unfunded members`)
    console.log(
      `  Phase 2: ${phase2PassCount}/${ranksWithNoDotMembers} — forceAssetStatus(isSufficient: true) fixes it`,
    )

    const phase2Pass = phase2PassCount === ranksWithNoDotMembers
    console.log(`\n${phase1Pass && phase2Pass ? 'PASS' : 'FAIL'}: forceAssetStatus resolves the isSufficient problem`)
    if (!phase2Pass) process.exitCode = 1
  } finally {
    process.exit(process.exitCode ?? 0)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
