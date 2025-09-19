/**
 * E2E test for Proof of Ink (PoI) personhood proving process using manually created transaction extensions
 */

import { defaultAccounts } from '@e2e-test/networks'
import { assetHubPolkadot, peoplePolkadot, polkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'
import { createXcmTransactSend, scheduleCallWithOrigin } from '@e2e-test/shared/helpers'

import { describe, expect, test } from 'vitest'

import { MIGRATION_CONSTANTS } from './helpers/migration-constants.js'
import { createPeoplePolkadotApi, submitPeoplePolkadotTransaction } from './helpers/people-polkadot-transaction.js'
import { TEST_PUBLIC_KEY, TEST_VOUCHER_KEY_1, TEST_VOUCHER_KEY_2, TEST_VRF_SIGNATURE } from './helpers/test-keys.js'

describe('People Polkadot PoI E2E with Manual Transaction Extensions', () => {
  test('candidate proves personhood via proof of ink flow', async () => {
    const [relayClient, assetHubClient, peopleClient] = await setupNetworks(polkadot, assetHubPolkadot, peoplePolkadot)

    // API with custom transaction extensions
    const api = await createPeoplePolkadotApi(peopleClient)

    // Waiting for storage initialization to complete (creates design families)
    console.log('Waiting for storage initialization to finish...')
    for (let i = 0; i < 20; i++) {
      await peopleClient.dev.newBlock()
      await assetHubClient.dev.newBlock()
    }
    const onPollStatus = await peopleClient.api.query.storageInitialization?.onPollStatus?.()
    expect(onPollStatus).toBeDefined()
    expect(onPollStatus.toString()).toBe('Completed')

    // To check if design families were created by storage initialization
    const designFamily0 = await api.query.proofOfInk.designFamilies(0)
    expect(designFamily0.isSome).toBe(true)

    const candidate = defaultAccounts.keyring.addFromUri('//TestCandidate')
    await fundAccount(peopleClient, candidate.address)

    console.log('Step 1: Candidate applies for proof of ink')
    const applyTx = api.tx.proofOfInk.apply()
    await submitPeoplePolkadotTransaction(peopleClient, applyTx, candidate)
    await peopleClient.dev.newBlock()

    const candidateInfo = await api.query.proofOfInk.candidates(candidate.address)
    expect(candidateInfo.isSome).toBe(true)

    console.log('Step 2: Candidate commits to a tattoo design')
    const commitTx = api.tx.proofOfInk.commit({ DesignedElective: [0, 0] }, null)
    await submitPeoplePolkadotTransaction(peopleClient, commitTx, candidate)
    await peopleClient.dev.newBlock()

    const postCommitInfo = await api.query.proofOfInk.candidates(candidate.address)
    expect(postCommitInfo.isSome).toBe(true)

    console.log('Step 3: Candidate submits evidence')
    const evidenceHash = new Uint8Array(32).fill(1)
    const submitEvidenceTx = api.tx.proofOfInk.submitEvidence(evidenceHash)
    await submitPeoplePolkadotTransaction(peopleClient, submitEvidenceTx, candidate)

    // Wait for evidence submission to trigger mob rule case
    for (let i = 0; i < 3; i++) {
      await peopleClient.dev.newBlock()
    }

    const caseCount = await api.query.mobRule.caseCount()
    expect(caseCount.toNumber()).toBeGreaterThan(0)

    console.log('Step 4: Evidence validation')
    const latestCaseIndex = caseCount.toNumber() - 1

    // Send XCM Transact from relay chain to execute mobRule.intervene with governance origin
    const interveneTx = api.tx.mobRule.intervene(latestCaseIndex, { Truth: { True: null } })

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

    const resolvedCase = await api.query.mobRule.doneCases(latestCaseIndex)
    expect(resolvedCase.isNone).toBe(false)

    console.log('Step 5: Candidate registers as verified person')
    await fundSystemPots(peopleClient)

    const registerTx = api.tx.proofOfInk.registerNonReferred(
      TEST_PUBLIC_KEY,
      TEST_VOUCHER_KEY_1,
      TEST_VOUCHER_KEY_2,
      TEST_VRF_SIGNATURE,
    )

    await submitPeoplePolkadotTransaction(peopleClient, registerTx, candidate)
    await peopleClient.dev.newBlock()

    // Waiting for privacy voucher registration processing
    for (let i = 0; i < 3; i++) {
      await peopleClient.dev.newBlock()
    }

    const peopleEntries = await api.query.proofOfInk.people.entries()
    expect(peopleEntries.length).toBe(1)

    const [registeredPersonId, personData] = peopleEntries[0]

    const humanData = personData.toHuman()
    expect(humanData.design).toBeDefined()
    expect(humanData.design.DesignedElective).toEqual(['0', '0'])
    expect(humanData.allowedReferralTickets).toBe('1')
    expect(humanData.banned).toBe(false)

    const candidateStatus = await api.query.proofOfInk.candidates(candidate.address)
    expect(candidateStatus.isNone).toBe(true)

    console.log('Step 6: Verify privacy vouchers were issued')
    await validatePrivacyVouchers(api)
  }, 300000)
})

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

async function validatePrivacyVouchers(api: any) {
  const voucher1Mapping = await api.query.privacyVoucher.keysToRing(TEST_VOUCHER_KEY_1)
  const voucher2Mapping = await api.query.privacyVoucher.keysToRing(TEST_VOUCHER_KEY_2)

  expect(voucher1Mapping.isSome).toBe(true)
  expect(voucher2Mapping.isSome).toBe(true)

  const [value1, ringIndex1] = voucher1Mapping.unwrap()
  const [value2, ringIndex2] = voucher2Mapping.unwrap()

  expect(value1.toString()).toBe(MIGRATION_CONSTANTS.PRIVACY_VOUCHER_VALUE_REFERRED.toString())
  expect(value2.toString()).toBe(MIGRATION_CONSTANTS.PRIVACY_VOUCHER_VALUE_REFERRER.toString())

  // Check that voucher 1 exists in its ring
  const voucher1RingKeys = await api.query.privacyVoucher.keys(value1, ringIndex1)
  expect(voucher1RingKeys.isSome).toBe(true)

  const ring1Keys = voucher1RingKeys.unwrap()
  const testKey1InRing = ring1Keys.some(
    (key: any) => JSON.stringify(Array.from(key)) === JSON.stringify(Array.from(TEST_VOUCHER_KEY_1)),
  )
  expect(testKey1InRing).toBe(true)

  // Check that voucher 2 exists in its ring
  const voucher2RingKeys = await api.query.privacyVoucher.keys(value2, ringIndex2)
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
