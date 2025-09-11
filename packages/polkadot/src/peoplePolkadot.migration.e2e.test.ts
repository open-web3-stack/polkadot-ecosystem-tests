import { assetHubPolkadot, peoplePolkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'

import type { ApiPromise } from '@polkadot/api'
import { hexToU8a, u8aToHex } from '@polkadot/util'

import { describe, expect, test } from 'vitest'

import { MIGRATION_CONSTANTS } from './helpers/migration-constants.js'

function tryDecodeVec(api: ApiPromise, hex: string) {
  try {
    const vec = api.createType('Vec<XcmVersionedXcm>', hex)
    // If it really was a vec, re-encode should exactly match the input bytes
    if (u8aToHex(vec.toU8a()) === hex.toLowerCase()) return vec.toArray()
  } catch {}
  return null
}

function peelConcatenatedVersionedXcm(api: ApiPromise, bytes: Uint8Array) {
  const out: any[] = []
  let offset = 0
  while (offset < bytes.length) {
    const slice = bytes.subarray(offset)
    // This will throw if the slice doesn't begin with a VersionedXcm
    const ver = api.createType('XcmVersionedXcm', slice)
    const consumed = ver.toU8a().length
    if (consumed <= 0) throw new Error('Zero-length decode')
    out.push(ver)
    offset += consumed
  }
  return out
}

function decodeHrmpDataAsXcmsV5(api: ApiPromise, hex: string) {
  // 1) Try Vec<VersionedXcm>
  const vec = tryDecodeVec(api, hex)
  if (vec && vec.length > 0) return vec.map((v) => (v.isV5 ? v.asV5 : v))

  // 2) Try concatenated
  const all = hexToU8a(hex)
  try {
    const parts = peelConcatenatedVersionedXcm(api, all)
    return parts.map((v) => (v.isV5 ? v.asV5 : v))
  } catch {}

  // 3) Try "leading sentinel + concatenated"
  if (all.length > 0) {
    try {
      const parts = peelConcatenatedVersionedXcm(api, all.subarray(1))
      return parts.map((v) => (v.isV5 ? v.asV5 : v))
    } catch {}
  }

  throw new Error('Unsupported HRMP payload format: could not decode VersionedXcm')
}

describe('People Polkadot Migration E2E', () => {
  test(
    'individuality pallets initialize successfully via multi-block migration',
    async () => {
      const [assetHubClient, peopleClient] = await setupNetworks(assetHubPolkadot, peoplePolkadot)

      await monitorMigrationProgress(peopleClient.api, peopleClient.dev)
      await validatePostMigrationState(peopleClient.api)

      await monitorOnPollProgress(peopleClient.api, peopleClient.dev, assetHubClient)
      await validatePostOnPollState(peopleClient.api)
    },
    { timeout: 120000 },
  )
})

async function monitorMigrationProgress(api: ApiPromise, dev: any) {
  console.log('Monitoring migration progress')

  for (let attempts = 0; attempts < MIGRATION_CONSTANTS.MAX_MIGRATION_BLOCKS; attempts++) {
    await dev.newBlock()

    const migrationsApi = api.query.migrations || api.query.multiBlockMigrations
    if (migrationsApi?.cursor) {
      const cursor = await migrationsApi.cursor()
      if (cursor?.isNone) {
        console.log(`Migration completed after ${attempts + 1} blocks`)
        return
      }
    }

    if (migrationsApi?.ongoing) {
      const ongoing = await migrationsApi.ongoing()
      const ongoingCount = Array.isArray(ongoing) ? ongoing.length : ongoing?.isSome ? 1 : 0
      if (ongoingCount === 0) {
        console.log(`Migration completed after ${attempts + 1} blocks`)
        return
      }
    }
  }

  throw new Error(`Migration did not complete within ${MIGRATION_CONSTANTS.MAX_MIGRATION_BLOCKS} blocks`)
}

async function validatePostMigrationState(api: ApiPromise) {
  console.log('Validating post-migration state')

  const peopleChunks = (await api.query.peopleMulti?.chunks?.entries?.()) || []
  const peopleChunkCount =
    peopleChunks.length > 0 && peopleChunks[0][1]?.isSome ? peopleChunks[0][1].unwrap().length : 0
  expect(peopleChunkCount).toBe(MIGRATION_CONSTANTS.EXPECTED_CHUNKS_COUNT)

  const peopleEntries = (await api.query.peopleMulti?.people?.entries?.()) || []
  const keysEntries = (await api.query.peopleMulti?.keys?.entries?.()) || []
  const nextPersonalId = await api.query.peopleMulti?.nextPersonalId?.()
  expect(peopleEntries.length).toBe(MIGRATION_CONSTANTS.EXPECTED_INITIAL_PEOPLE_COUNT)
  expect(keysEntries.length).toBe(MIGRATION_CONSTANTS.EXPECTED_INITIAL_PEOPLE_COUNT)
  expect(nextPersonalId.toString()).toBe(MIGRATION_CONSTANTS.EXPECTED_INITIAL_PEOPLE_COUNT.toString())

  const onboardingSize = await api.query.peopleMulti?.onboardingSize?.()
  expect(onboardingSize.toString()).toBe(MIGRATION_CONSTANTS.EXPECTED_ONBOARDING_SIZE.toString())

  const privacyVoucherChunks = (await api.query.privacyVoucher?.chunks?.entries?.()) || []
  const privacyChunkCount =
    privacyVoucherChunks.length > 0 && privacyVoucherChunks[0][1]?.isSome
      ? privacyVoucherChunks[0][1].unwrap().length
      : 0
  expect(privacyChunkCount).toBe(MIGRATION_CONSTANTS.EXPECTED_CHUNKS_COUNT)

  const designFamiliesCount = ((await api.query.proofOfInk?.designFamilies?.entries?.()) || []).length
  const proofOfInkConfig = await api.query.proofOfInk?.configuration?.()
  expect(designFamiliesCount).toBe(MIGRATION_CONSTANTS.EXPECTED_DESIGN_FAMILIES_COUNT)
  expect(proofOfInkConfig).toBeDefined()
  expect(proofOfInkConfig?.toString()).not.toBe('{}')

  const postGameSchedules = await api.query.game?.gameSchedules?.()
  const gameSchedulesLength = Array.isArray(postGameSchedules) ? postGameSchedules.length : postGameSchedules ? 1 : 0
  expect(gameSchedulesLength).toBe(MIGRATION_CONSTANTS.EXPECTED_GAME_SCHEDULES_COUNT)

  const poiInvites = (await api.query.proofOfInk?.availableInvites?.entries?.()) || []
  const gameInvites = (await api.query.game?.availableInvites?.entries?.()) || []
  expect(poiInvites.length).toBeGreaterThan(0)
  expect(gameInvites.length).toBeGreaterThan(0)

  const onPollStatus = await api.query.storageInitialization?.onPollStatus?.()
  expect(onPollStatus).toBeDefined()
  expect(onPollStatus.toString()).toBe('CreatingAsset')

  console.log('Migration validation completed successfully')
}

async function monitorOnPollProgress(api: ApiPromise, dev: any, assetHubClient: any) {
  console.log('Monitoring on_poll progress')

  let previousState = ''

  for (let attempts = 0; attempts < MIGRATION_CONSTANTS.MAX_ON_POLL_BLOCKS; attempts++) {
    const onPollStatus = await api.query.storageInitialization?.onPollStatus?.()
    const currentState = onPollStatus?.toString() || 'Unknown'

    if (currentState !== previousState) {
      console.log(`\n🔄 OnPoll transition: ${previousState || 'Unknown'} → ${currentState} (Block ${attempts + 1})`)
      previousState = currentState
    }

    if (currentState === 'Completed') {
      console.log('OnPoll process completed')
      return
    }

    if (currentState === 'XcmFundsTransfer' || currentState === 'VerifyingFunds') {
      const assetHubEvents = await assetHubClient.api.query.system.events()
      const xcmEvents = assetHubEvents.filter(
        (e) => e.event.section === 'xcmpQueue' || e.event.section === 'messageQueue',
      )
      console.log(
        'Asset Hub XCM events:',
        xcmEvents.map((e) => JSON.stringify(e.toHuman())),
      )

      const peopleEvents = await api.query.system.events()
      console.log(
        'People events:',
        peopleEvents.map((e) => JSON.stringify(e.toHuman())),
      )
    }

    await logStateChanges(api, assetHubClient?.api || null, currentState)

    await assetHubClient.dev.newBlock()
    await dev.newBlock()
  }

  throw new Error(
    `OnPoll process did not complete within ${MIGRATION_CONSTANTS.MAX_ON_POLL_BLOCKS} blocks. Final state: ${previousState}`,
  )
}

async function logStateChanges(peopleApi: ApiPromise, assetHubApi: any, state: string) {
  try {
    const xcmTransferInitiated = await peopleApi.query.storageInitialization?.xcmTransferInitiatedAt?.()
    console.log(
      `  - Transfer initiated at block: ${
        xcmTransferInitiated?.isSome ? xcmTransferInitiated.unwrap().toString() : 'Not yet initiated'
      }`,
    )

    const currentBlock = (await peopleApi.rpc.chain.getHeader()).number.toNumber()

    if (xcmTransferInitiated?.isSome) {
      const initiatedBlock = xcmTransferInitiated.unwrap().toNumber()
      const blocksWaiting = currentBlock - initiatedBlock
      console.log(`  - Transfer initiated at block: ${initiatedBlock}`)
      console.log(`  - Current block: ${currentBlock}`)
      console.log(`  - Blocks waiting: ${blocksWaiting}`)
    }

    const sovereignUsdcBalance1 = await assetHubApi.query.assets?.account?.(
      1337,
      '5Eg2fntPdLr67jPWMPa9MK7ywRHJ8rAtsgoppSKH8X2bgiiV',
    ) // 5M
    console.log('USDC balance checks:', {
      sovereignUsdcBalance1: sovereignUsdcBalance1?.isSome ? sovereignUsdcBalance1.unwrap().balance.toString() : '0',
    })

    const usdcAsset = {
      parents: 1,
      interior: { X3: [{ Parachain: 1000 }, { PalletInstance: 50 }, { GeneralIndex: 1337 }] },
    }
    const sovereignUsdcBalanceppl1 = await peopleApi.query.assets?.account?.(
      usdcAsset,
      '13YMK2eeQPvfRffsm2g4NpcKYZbe7jfvtXtsimn8ot2Z1W17',
    ) // gets 3M
    const sovereignUsdcBalanceppl3 = await peopleApi.query.assets?.account?.(
      usdcAsset,
      '5Ec4AhPaYcfBz8fMoPd4EfnAgwbzRS7np3APZUnnFo12qEYk',
    ) // gets 3M

    console.log('USDC balance checks:', {
      sovereignUsdcBalanceppl1: sovereignUsdcBalanceppl1?.isSome
        ? sovereignUsdcBalanceppl1.unwrap().balance.toString()
        : '0',
      sovereignUsdcBalanceppl3: sovereignUsdcBalanceppl3?.isSome
        ? sovereignUsdcBalanceppl3.unwrap().balance.toString()
        : '0',
    })

    try {
      const peopleOutboundMessages = await peopleApi.query.parachainSystem?.hrmpOutboundMessages?.()
      console.log(`    - People Chain outbound messages: ${peopleOutboundMessages?.length || 0}`)

      if (peopleOutboundMessages && peopleOutboundMessages.length > 0) {
        console.log('  XCM Message:')

        peopleOutboundMessages.forEach((msg: any, _index: number) => {
          console.log(`      - Recipient Para ID: ${msg.recipient}`)

          // Parsing XCM message if possible
          try {
            const xcmMessage = msg.data

            if (xcmMessage.toString().startsWith('0x')) {
              const hexData = xcmMessage.toString()

              try {
                const xcms = decodeHrmpDataAsXcmsV5(peopleApi, hexData)
                console.log(`      - Successfully decoded ${xcms.length} XCM message(s):`)
                xcms.forEach((xcm, i) => {
                  const v = xcm.isV5 ? xcm.asV5 : xcm
                  const human = v.toHuman()
                  console.log(`      - [${i}] XCM v5 (human):`)
                  console.dir(human, { depth: null })
                })
              } catch (decodeError) {
                console.log(`      - XCM decoding failed: ${decodeError.message}`)
                console.log(`      - Raw hex data: ${hexData}`)

                const bytes = hexData.match(/.{2}/g) || []
                console.log(`      - Byte analysis (first 20 bytes):`)
                for (let i = 0; i < Math.min(20, bytes.length); i++) {
                  console.log(`        [${i}]: 0x${bytes[i]} (${parseInt(bytes[i], 16)})`)
                }
              }
            }
          } catch (parseError) {
            console.log(`      - XCM parsing failed: ${parseError.message}`)
          }
        })

        try {
          const assetHubOutboundMessages = await assetHubApi?.query.parachainSystem?.hrmpOutboundMessages?.()
          console.log(`    - Asset Hub outbound messages: ${assetHubOutboundMessages?.length || 0}`)

          if (assetHubOutboundMessages && assetHubOutboundMessages.length > 0) {
            const toPeopleMessages = assetHubOutboundMessages.filter(
              (msg: any) => msg.recipient === 1004 || msg.recipient === '1004',
            )
            console.log(`    - Messages to People Chain: ${toPeopleMessages.length}`)

            if (toPeopleMessages.length > 0) {
              console.log('  Outbound Messages to People Chain from Asset Hub:')
              toPeopleMessages.forEach((msg: any, index: number) => {
                console.log(`    Asset Hub → People Message ${index + 1}:`)
                console.log(`      - Recipient Para ID: ${msg.recipient}`)

                // Try to decode XCM message from Asset Hub
                try {
                  if (msg.data.toString().startsWith('0x')) {
                    const hexData = msg.data.toString()
                    const xcms = decodeHrmpDataAsXcmsV5(assetHubApi, hexData)
                    console.log(`      - Successfully decoded ${xcms.length} XCM message(s) from Asset Hub:`)
                    xcms.forEach((xcm, i) => {
                      const v = xcm.isV5 ? xcm.asV5 : xcm
                      const human = v.toHuman()
                      console.log(`      - [${i}] Asset Hub XCM v5 (human):`)
                      console.dir(human, { depth: null })
                    })
                  }
                } catch (decodeError) {
                  console.log(`      - Asset Hub XCM decoding failed: ${decodeError.message}`)
                }
              })
            }
          }
        } catch (assetHubOutboundError) {
          console.log(
            `    - Asset Hub outbound queue check failed: ${assetHubOutboundError?.message || 'API not available'}`,
          )
        }
      }
    } catch (hrmpError) {
      console.log('  - ⚠️ HRMP queue check failed:', hrmpError.message)
    }
  } catch (error) {
    console.error(`Failed to log state info for ${state}:`, error.message)
  }
}

async function validatePostOnPollState(api: ApiPromise) {
  console.log('Validating post on-poll state')

  const onPollStatus = await api.query.storageInitialization?.onPollStatus?.()
  expect(onPollStatus).toBeDefined()
  expect(onPollStatus.toString()).toBe('Completed')

  const assetId = {
    parents: 1,
    interior: { X3: [{ Parachain: 1000 }, { PalletInstance: 50 }, { GeneralIndex: 1337 }] },
  }

  const assetHub1337Info = await api.query.assets?.asset?.(assetId)
  expect(assetHub1337Info?.isSome).toBe(true)

  const xcmTransferInitiatedAt = await api.query.storageInitialization?.xcmTransferInitiatedAt?.()
  expect(xcmTransferInitiatedAt?.isNone || !xcmTransferInitiatedAt).toBe(true)

  const palletAccount = '5Ec4AhPaYcfBz8fMoPd4EfnAgwbzRS7np3APZUnnFo12qEYk'
  const palletBalance = await api.query.assets?.account?.(assetId, palletAccount)
  const balance = palletBalance?.isSome ? palletBalance.unwrap().balance.toString() : '0'
  expect(Number(balance)).toBeGreaterThan(0)

  const expectedPotFunding = MIGRATION_CONSTANTS.EXPECTED_POT_FUNDING_AMOUNT

  // Privacy Voucher pot
  const privacyVoucherPot = api.createType('AccountId32', '5EYCAe5cKX69Mxxed85UP31RW4kBcvj3XZDdnW6aQktrkEzF')
  const privacyVoucherBalance = await api.query.assets?.account?.(assetId, privacyVoucherPot)
  const privacyVoucherAmount = privacyVoucherBalance?.isSome ? privacyVoucherBalance.unwrap().balance.toString() : '0'
  expect(Number(privacyVoucherAmount)).toBeGreaterThanOrEqual(expectedPotFunding)

  // Proof of Ink pot
  const proofOfInkPot = api.createType('AccountId32', '5EYCAe5cKNj94aT7so7yim4AjuCPBaTcZN7s3q3Catj25W55')
  const proofOfInkBalance = await api.query.assets?.account?.(assetId, proofOfInkPot)
  const proofOfInkAmount = proofOfInkBalance?.isSome ? proofOfInkBalance.unwrap().balance.toString() : '0'
  expect(Number(proofOfInkAmount)).toBeGreaterThanOrEqual(expectedPotFunding)

  // Mob Rule pot
  const mobRulePot = api.createType('AccountId32', '5EYCAe5biWpWmazrztq9xjjy3vNhR5ZfF44FTP5a3peKZVrw')
  const mobRuleBalance = await api.query.assets?.account?.(assetId, mobRulePot)
  const mobRuleAmount = mobRuleBalance?.isSome ? mobRuleBalance.unwrap().balance.toString() : '0'
  expect(Number(mobRuleAmount)).toBeGreaterThanOrEqual(expectedPotFunding)

  // Score pot
  const scorePot = api.createType('AccountId32', '5EYCAe5jKbSeb7z6DKnvn7f3An3cREmaHWaocjngJ5B48P73')
  const scoreBalance = await api.query.assets?.account?.(assetId, scorePot)
  const scoreAmount = scoreBalance?.isSome ? scoreBalance.unwrap().balance.toString() : '0'
  expect(Number(scoreAmount)).toBeGreaterThanOrEqual(expectedPotFunding)

  // Mob Rule shcedules
  const mobRuleSchedules = await api.query.mobRule?.roundSchedules?.()
  expect(mobRuleSchedules).toBeDefined()
  const mobRuleScheduleArray = Array.isArray(mobRuleSchedules) ? mobRuleSchedules : [mobRuleSchedules]
  expect(mobRuleScheduleArray.length).toBeGreaterThan(0)

  // Score schedules
  const scoreSchedules = await api.query.score?.roundSchedules?.()
  expect(scoreSchedules).toBeDefined()
  const scoreScheduleArray = Array.isArray(scoreSchedules) ? scoreSchedules : [scoreSchedules]
  expect(scoreScheduleArray.length).toBeGreaterThan(0)

  console.log('on-poll validation completed successfully')
}
