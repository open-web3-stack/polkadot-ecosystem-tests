import { peoplePolkadot } from '@e2e-test/networks/chains'
import { setupNetworks } from '@e2e-test/shared'

import type { ApiPromise } from '@polkadot/api'

import { describe, expect, test } from 'vitest'

import { MIGRATION_CONSTANTS } from './helpers/migration-constants.js'

describe('People Polkadot Migration E2E', () => {
  test(
    'individuality pallets initialize successfully via multi-block migration',
    async () => {
      const [peopleClient] = await setupNetworks(peoplePolkadot)

      await monitorMigrationProgress(peopleClient.api, peopleClient.dev)
      await validatePostMigrationState(peopleClient.api)
    },
    { timeout: 300000 },
  )
})

async function monitorMigrationProgress(api: ApiPromise, dev: any) {
  let attempts = 0

  while (attempts < MIGRATION_CONSTANTS.MAX_MIGRATION_BLOCKS) {
    console.log('Migration still ongoing - block:', attempts + 1)

    await dev.newBlock()

    // Check migrations pallet cursor
    const migrationsApi = api.query.migrations || api.query.multiBlockMigrations
    if (migrationsApi?.cursor) {
      const cursor = await migrationsApi.cursor()
      if (cursor?.isNone) {
        console.log('Migration completed successfully')
        return
      }
    }

    // Check ongoing migrations
    if (migrationsApi?.ongoing) {
      const ongoing = await migrationsApi.ongoing()
      const ongoingCount = Array.isArray(ongoing) ? ongoing.length : ongoing?.isSome ? 1 : 0

      if (ongoingCount === 0) {
        console.log('No ongoing migrations - completed')
        return
      }
    }

    attempts++
  }

  throw new Error(`Migration did not complete within ${MIGRATION_CONSTANTS.MAX_MIGRATION_BLOCKS} blocks`)
}

async function validatePostMigrationState(api: ApiPromise) {
  console.log('Validating all migration steps were completed...')

  // Chunks should be populated for pallet people
  const peopleChunks = (await api.query.peopleMulti?.chunks?.entries?.()) || []
  const peopleChunkData = peopleChunks.length > 0 ? peopleChunks[0][1] : null
  const peopleChunkCount = peopleChunkData?.isSome ? peopleChunkData.unwrap().length : 0
  expect(peopleChunkCount).toBe(MIGRATION_CONSTANTS.EXPECTED_CHUNKS_COUNT)
  console.log('People chunks initialized -', peopleChunkCount, 'chunks')

  // People should be recognized
  const peopleEntries = (await api.query.peopleMulti?.people?.entries?.()) || []
  const keysEntries = (await api.query.peopleMulti?.keys?.entries?.()) || []
  const nextPersonalId = (await api.query.peopleMulti?.nextPersonalId?.()) || 0
  expect(peopleEntries.length).toBe(MIGRATION_CONSTANTS.EXPECTED_INITIAL_PEOPLE_COUNT)
  expect(keysEntries.length).toBe(MIGRATION_CONSTANTS.EXPECTED_INITIAL_PEOPLE_COUNT)
  expect(nextPersonalId.toString()).toBe(MIGRATION_CONSTANTS.EXPECTED_INITIAL_PEOPLE_COUNT.toString())
  console.log('People recognized -', peopleEntries.length, 'people, nextId:', nextPersonalId.toString())

  // Onboarding size should be set
  const onboardingSize = (await api.query.peopleMulti?.onboardingSize?.()) || 0
  expect(onboardingSize.toString()).toBe(MIGRATION_CONSTANTS.EXPECTED_ONBOARDING_SIZE.toString())
  console.log('Onboarding size set -', onboardingSize.toString())

  // Privacy voucher chunks should be populated
  const privacyVoucherChunks = (await api.query.privacyVoucher?.chunks?.entries?.()) || []
  const privacyChunkData = privacyVoucherChunks.length > 0 ? privacyVoucherChunks[0][1] : null
  const privacyChunkCount = privacyChunkData?.isSome ? privacyChunkData.unwrap().length : 0
  expect(privacyChunkCount).toBe(MIGRATION_CONSTANTS.EXPECTED_CHUNKS_COUNT)
  console.log('Privacy voucher chunks initialized -', privacyChunkCount, 'chunks')

  // Design families and configuration should be set
  const designFamiliesCount = ((await api.query.proofOfInk?.designFamilies?.entries?.()) || []).length
  const proofOfInkConfig = await api.query.proofOfInk?.configuration?.()
  expect(designFamiliesCount).toBe(MIGRATION_CONSTANTS.EXPECTED_DESIGN_FAMILIES_COUNT)
  expect(proofOfInkConfig).toBeDefined()
  expect(proofOfInkConfig?.toString()).not.toBe('{}')
  console.log('Proof of Ink initialized -', designFamiliesCount, 'design families, config set')

  // Game schedules should be created
  const postGameSchedules = await api.query.game?.gameSchedules?.()
  const gameSchedulesLength = Array.isArray(postGameSchedules) ? postGameSchedules.length : postGameSchedules ? 1 : 0
  expect(gameSchedulesLength).toBe(MIGRATION_CONSTANTS.EXPECTED_GAME_SCHEDULES_COUNT)
  console.log('Games scheduled -', gameSchedulesLength, 'game schedules')

  console.log('All migration steps validated successfully!')
}
