/**
 * E2E test for Proof of Ink (PoI) personhood proving process
 */

import { sendTransaction } from '@acala-network/chopsticks-testing'

import { defaultAccounts } from '@e2e-test/networks'
import { peoplePolkadot, polkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { createXcmTransactSend, scheduleCallWithOrigin } from '@e2e-test/shared/helpers'

import { describe, expect, test } from 'vitest'

import { MIGRATION_CONSTANTS } from './helpers/migration-constants.js'
import { TEST_PUBLIC_KEY, TEST_VOUCHER_KEY_1, TEST_VOUCHER_KEY_2, TEST_VRF_SIGNATURE } from './helpers/test-keys.js'

describe('People Polkadot PoI E2E', () => {
  test('candidate proves personhood via proof of ink flow', async () => {
    const [relayClient, peopleClient] = await setupNetworks(polkadot, peoplePolkadot)

    // Wait for storage initialization to complete
    for (let i = 0; i < 15; i++) {
      await peopleClient.dev.newBlock()
    }

    await setupProofOfInkDesignFamily(peopleClient)

    const candidate = defaultAccounts.keyring.addFromUri('//TestCandidate')
    await fundAccount(peopleClient, candidate.address)

    console.log('Step 1: Candidate applies for proof of ink')
    const applyTx = peopleClient.api.tx.proofOfInk.apply()
    await sendTransaction(applyTx.signAsync(candidate))
    await peopleClient.dev.newBlock()

    const candidateInfo = await peopleClient.api.query.proofOfInk.candidates(candidate.address)
    expect(candidateInfo.isSome).toBe(true)

    console.log('Step 2: Candidate commits to a tattoo design')
    const commitTx = peopleClient.api.tx.proofOfInk.commit({ DesignedElective: [0, 0] }, null)
    await sendTransaction(commitTx.signAsync(candidate))
    await peopleClient.dev.newBlock()

    const postCommitInfo = await peopleClient.api.query.proofOfInk.candidates(candidate.address)
    expect(postCommitInfo.isSome).toBe(true)

    console.log('Step 3: Candidate submits evidence')
    const evidenceHash = new Uint8Array(32).fill(1)
    const submitEvidenceTx = peopleClient.api.tx.proofOfInk.submitEvidence(evidenceHash)
    await sendTransaction(submitEvidenceTx.signAsync(candidate))

    // Wait for evidence submission to trigger mob rule case
    for (let i = 0; i < 3; i++) {
      await peopleClient.dev.newBlock()
    }

    const caseCount = await peopleClient.api.query.mobRule.caseCount()
    expect(caseCount.toNumber()).toBeGreaterThan(0)

    console.log('Step 4: Evidence validation')
    const latestCaseIndex = caseCount.toNumber() - 1

    // Send XCM Transact from relay chain to execute mobRule.intervene with governance origin
    const interveneTx = peopleClient.api.tx.mobRule.intervene(latestCaseIndex, { Truth: { True: null } })

    const xcmTx = createXcmTransactSend(
      relayClient,
      {
        parents: 0,
        interior: {
          X1: [{ Parachain: 1004 }],
        },
      },
      interveneTx.method.toHex(),
      'SuperUser',
      { proofSize: '4000', refTime: '22000000' },
    )

    // Execute the XCM call from relay chain with Root origin
    await scheduleCallWithOrigin(relayClient, { Inline: xcmTx.method.toHex() }, { system: 'Root' })

    // Mine blocks to process the XCM message
    await relayClient.dev.newBlock()
    await peopleClient.dev.newBlock()

    const resolvedCase = await peopleClient.api.query.mobRule.doneCases(latestCaseIndex)
    expect(resolvedCase.isNone).toBe(false)

    console.log('Step 5: Candidate registers as verified person')
    await fundSystemPots(peopleClient)

    const registerTx = peopleClient.api.tx.proofOfInk.registerNonReferred(
      TEST_PUBLIC_KEY,
      TEST_VOUCHER_KEY_1,
      TEST_VOUCHER_KEY_2,
      TEST_VRF_SIGNATURE,
    )

    await sendTransaction(registerTx.signAsync(candidate))
    await peopleClient.dev.newBlock()

    // Wait for privacy voucher registration processing
    for (let i = 0; i < 3; i++) {
      await peopleClient.dev.newBlock()
    }

    const peopleEntries = await peopleClient.api.query.proofOfInk.people.entries()
    expect(peopleEntries.length).toBe(1)

    const [registeredPersonId, personData] = peopleEntries[0]

    const humanData = personData.toHuman()
    expect(humanData.design).toBeDefined()
    expect(humanData.design.DesignedElective).toEqual(['0', '0'])
    expect(humanData.allowedReferralTickets).toBe('1')
    expect(humanData.banned).toBe(false)

    const candidateStatus = await peopleClient.api.query.proofOfInk.candidates(candidate.address)
    expect(candidateStatus.isNone).toBe(true)

    console.log('Step 6: Verify privacy vouchers were issued')
    await validatePrivacyVouchers(peopleClient)
  }, 300000)
})

async function setupProofOfInkDesignFamily(client: any) {
  await fundAccount(client, defaultAccounts.alice.address)

  const addDesignFamilyTx = client.api.tx.proofOfInk.addDesignFamily(
    0,
    { Designed: { count: 10 } },
    new Uint8Array(32).fill(0),
  )

  await sendTransaction(addDesignFamilyTx.signAsync(defaultAccounts.alice))
}

async function fundSystemPots(client: any) {
  const derivePotAccount = (palletIdStr: string) => {
    const modlPrefix = new Uint8Array([109, 111, 100, 108])
    const palletIdBytes = new TextEncoder().encode(palletIdStr)
    const palletId = new Uint8Array(8)
    palletId.set(palletIdBytes.slice(0, 8))

    const fullId = new Uint8Array(32)
    fullId.set(modlPrefix, 0)
    fullId.set(palletId, 4)

    return client.api.createType('AccountId', fullId).toString()
  }

  const proofOfInkPot = derivePotAccount('PoIPot__')
  const privacyVoucherPot = derivePotAccount('PrvVouch')

  await Promise.all([fundAccount(client, proofOfInkPot), fundAccount(client, privacyVoucherPot)])
}

async function validatePrivacyVouchers(client: any) {
  const voucher1Mapping = await client.api.query.privacyVoucher.keysToRing(TEST_VOUCHER_KEY_1)
  const voucher2Mapping = await client.api.query.privacyVoucher.keysToRing(TEST_VOUCHER_KEY_2)

  expect(voucher1Mapping.isSome).toBe(true)
  expect(voucher2Mapping.isSome).toBe(true)

  const [value1, ringIndex1] = voucher1Mapping.unwrap()
  const [value2, ringIndex2] = voucher2Mapping.unwrap()

  expect(value1.toString()).toBe(MIGRATION_CONSTANTS.PRIVACY_VOUCHER_VALUE_REFERRED.toString())
  expect(value2.toString()).toBe(MIGRATION_CONSTANTS.PRIVACY_VOUCHER_VALUE_REFERRER.toString())

  // Check that voucher 1 exists in its ring
  const voucher1RingKeys = await client.api.query.privacyVoucher.keys(value1, ringIndex1)
  expect(voucher1RingKeys.isSome).toBe(true)

  const ring1Keys = voucher1RingKeys.unwrap()
  const testKey1InRing = ring1Keys.some(
    (key: any) => JSON.stringify(Array.from(key)) === JSON.stringify(Array.from(TEST_VOUCHER_KEY_1)),
  )
  expect(testKey1InRing).toBe(true)

  // Check that voucher 2 exists in its ring
  const voucher2RingKeys = await client.api.query.privacyVoucher.keys(value2, ringIndex2)
  expect(voucher2RingKeys.isSome).toBe(true)

  const ring2Keys = voucher2RingKeys.unwrap()
  const testKey2InRing = ring2Keys.some(
    (key: any) => JSON.stringify(Array.from(key)) === JSON.stringify(Array.from(TEST_VOUCHER_KEY_2)),
  )
  expect(testKey2InRing).toBe(true)
}

async function fundAccount(client: any, address: string) {
  await client.dev.setStorage({
    System: {
      account: [
        [
          [address],
          {
            providers: 1,
            data: {
              free: 1000000000000000,
              reserved: 0,
              frozen: 0,
              flags: 0,
            },
          },
        ],
      ],
    },
  })
}
