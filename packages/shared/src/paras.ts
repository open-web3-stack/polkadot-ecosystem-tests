import { type Chain, captureSnapshot, createNetworks } from '@e2e-test/networks'

import type { TestConfig } from './helpers/index.js'
import type { Client, RootTestTree } from './types.js'

/**
 * Test `paras.force_set_current_code`.
 */
export async function parasForceSetCurrentCodeE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(_client: Client<TCustom, TInitStorages>) {}

/**
 * Test `paras.force_set_current_head`.
 */
export async function parasForceSetCurrentHeadE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(_client: Client<TCustom, TInitStorages>) {}

/**
 * Test `paras.force_schedule_code_upgrade`.
 */
export async function parasForceScheduleCodeUpgradeE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(_client: Client<TCustom, TInitStorages>) {}

/**
 * Test `paras.force_note_new_head`.
 */
export async function parasForceNoteNewHeadE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(_client: Client<TCustom, TInitStorages>) {}

/**
 * Test `paras.force_queue_action`.
 */
export async function parasForceQueueActionE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(_client: Client<TCustom, TInitStorages>) {}

/**
 * Test `paras.add_trusted_validation_code` and `paras.poke_unused_validation_code`.
 */
export async function parasTrustedValidationCodeE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(_client: Client<TCustom, TInitStorages>) {}

/**
 * Test `paras.force_set_most_recent_context`.
 */
export async function parasForceSetMostRecentContextE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(_client: Client<TCustom, TInitStorages>) {}

/**
 * Test `paras.remove_upgrade_cooldown`.
 */
export async function parasRemoveUpgradeCooldownE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(_client: Client<TCustom, TInitStorages>) {}

/**
 * Test `paras.authorize_force_set_current_code_hash` and `paras.apply_authorized_force_set_current_code`.
 */
export async function parasAuthorizedForceSetCurrentCodeE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(_client: Client<TCustom, TInitStorages>) {}

export function parasE2ETest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: TestConfig): RootTestTree {
  let client!: Client<TCustom, TInitStorages>
  let restoreSnapshot: () => Promise<void>
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    beforeAll: async () => {
      ;[client] = await createNetworks(chain)
      restoreSnapshot = captureSnapshot(client)
    },
    beforeEach: async () => {
      await restoreSnapshot()
      const blockNumber = (await client.api.rpc.chain.getHeader()).number.toNumber()
      await client.dev.setHead(blockNumber)
    },
    afterAll: async () => {
      await client.api.disconnect().catch(() => {})
      await client.teardown().catch(() => {})
    },
    children: [
      {
        kind: 'test',
        label: 'pallet paras - force set current code',
        testFn: async () => await parasForceSetCurrentCodeE2ETest(client),
        flags: { skip: true },
      },
      {
        kind: 'test',
        label: 'pallet paras - force set current head',
        testFn: async () => await parasForceSetCurrentHeadE2ETest(client),
        flags: { skip: true },
      },
      {
        kind: 'test',
        label: 'pallet paras - force schedule code upgrade',
        testFn: async () => await parasForceScheduleCodeUpgradeE2ETest(client),
        flags: { skip: true },
      },
      {
        kind: 'test',
        label: 'pallet paras - force note new head',
        testFn: async () => await parasForceNoteNewHeadE2ETest(client),
        flags: { skip: true },
      },
      {
        kind: 'test',
        label: 'pallet paras - force queue action',
        testFn: async () => await parasForceQueueActionE2ETest(client),
        flags: { skip: true },
      },
      {
        kind: 'test',
        label: 'pallet paras - add trusted / poke unused validation code',
        testFn: async () => await parasTrustedValidationCodeE2ETest(client),
        flags: { skip: true },
      },
      {
        kind: 'test',
        label: 'pallet paras - force set most recent context',
        testFn: async () => await parasForceSetMostRecentContextE2ETest(client),
        flags: { skip: true },
      },
      {
        kind: 'test',
        label: 'pallet paras - remove upgrade cooldown',
        testFn: async () => await parasRemoveUpgradeCooldownE2ETest(client),
        flags: { skip: true },
      },
      {
        kind: 'test',
        label: 'pallet paras - authorize / apply force set current code',
        testFn: async () => await parasAuthorizedForceSetCurrentCodeE2ETest(client),
        flags: { skip: true },
      },
    ],
  }
}
