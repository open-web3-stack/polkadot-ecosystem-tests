import type { Chain } from '@e2e-test/networks'
import { check, type RootTestTree, scheduleInlineCallListWithSameOrigin, setupNetworks } from '@e2e-test/shared'

import type { u32, Vec } from '@polkadot/types'
import type {
  PolkadotPrimitivesV8SchedulerParams,
  PolkadotRuntimeParachainsConfigurationHostConfiguration,
} from '@polkadot/types/lookup'
import type { ITuple } from '@polkadot/types/types'

import { expect } from 'vitest'

import type { TestConfig } from './helpers/index.js'

export async function configurationTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const activeConfig = await client.api.query.configuration.activeConfig()
  await check(activeConfig).redact({ number: 1 }).toMatchSnapshot('initial active configuration')

  let pendingConfigs = await client.api.query.configuration.pendingConfigs()
  expect(pendingConfigs.toJSON()).toEqual([])

  // Core configuration
  const validationUpgradeCooldown = 13300
  const validationUpgradeDelay = 700
  const codeRetentionPeriod = 14300
  const maxCodeSize = 3000000
  const maxPovSize = 10000000
  const maxHeadDataSize = 20000
  const numCores = 50

  await scheduleInlineCallListWithSameOrigin(
    client,
    [
      client.api.tx.configuration.setValidationUpgradeCooldown(validationUpgradeCooldown).method.toHex(),
      client.api.tx.configuration.setValidationUpgradeDelay(validationUpgradeDelay).method.toHex(),
      client.api.tx.configuration.setCodeRetentionPeriod(codeRetentionPeriod).method.toHex(),
      client.api.tx.configuration.setMaxCodeSize(maxCodeSize).method.toHex(),
      client.api.tx.configuration.setMaxPovSize(maxPovSize).method.toHex(),
      client.api.tx.configuration.setMaxHeadDataSize(maxHeadDataSize).method.toHex(),
      client.api.tx.configuration.setCoretimeCores(numCores).method.toHex(),
    ],
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  pendingConfigs = (await client.api.query.configuration.pendingConfigs()) as Vec<
    ITuple<[u32, PolkadotRuntimeParachainsConfigurationHostConfiguration]>
  >
  const pending: PolkadotRuntimeParachainsConfigurationHostConfiguration = pendingConfigs[0][1]
  expect(pending.validationUpgradeCooldown.toNumber()).toBe(validationUpgradeCooldown)
  expect(pending.validationUpgradeDelay.toNumber()).toBe(validationUpgradeDelay)
  expect(pending.codeRetentionPeriod.toNumber()).toBe(codeRetentionPeriod)
  expect(pending.maxCodeSize.toNumber()).toBe(maxCodeSize)
  expect(pending.maxPovSize.toNumber()).toBe(maxPovSize)
  expect(pending.maxHeadDataSize.toNumber()).toBe(maxHeadDataSize)
  expect((pending.schedulerParams as PolkadotPrimitivesV8SchedulerParams).numCores.toNumber()).toBe(numCores)

  // Scheduler Configuration
  const groupRotationFrequency = 20
  const parasAvailabilityPeriod = 15
  const schedulingLookahead = 4
  const maxValidatorsPerCore = 10
  const maxValidators = 500

  await scheduleInlineCallListWithSameOrigin(
    client,
    [
      client.api.tx.configuration.setGroupRotationFrequency(groupRotationFrequency).method.toHex(),
      client.api.tx.configuration.setParasAvailabilityPeriod(parasAvailabilityPeriod).method.toHex(),
      client.api.tx.configuration.setSchedulingLookahead(schedulingLookahead).method.toHex(),
      client.api.tx.configuration.setMaxValidatorsPerCore(maxValidatorsPerCore).method.toHex(),
      client.api.tx.configuration.setMaxValidators(maxValidators).method.toHex(),
    ],
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  pendingConfigs = (await client.api.query.configuration.pendingConfigs()) as Vec<
    ITuple<[u32, PolkadotRuntimeParachainsConfigurationHostConfiguration]>
  >
  const schedulerPending: PolkadotRuntimeParachainsConfigurationHostConfiguration = pendingConfigs[0][1]
  const schedulerParams = schedulerPending.schedulerParams as PolkadotPrimitivesV8SchedulerParams
  expect(schedulerParams.groupRotationFrequency.toNumber()).toBe(groupRotationFrequency)
  expect(schedulerParams.parasAvailabilityPeriod.toNumber()).toBe(parasAvailabilityPeriod)
  expect(schedulerParams.lookahead.toNumber()).toBe(schedulingLookahead)
  expect(schedulerParams.maxValidatorsPerCore.unwrap().toNumber()).toBe(maxValidatorsPerCore)
  expect(schedulerPending.maxValidators.toJSON()).toBe(maxValidators)

  // Dispute Configuration
  const disputePeriod = 8
  const disputePostConclusionAcceptancePeriod = 700
  const noShowSlots = 4
  const nDelayTranches = 350
  const zerothDelayTrancheWidth = 1
  const neededApprovals = 25
  const relayVrfModuloSamples = 8

  await scheduleInlineCallListWithSameOrigin(
    client,
    [
      client.api.tx.configuration.setDisputePeriod(disputePeriod).method.toHex(),
      client.api.tx.configuration
        .setDisputePostConclusionAcceptancePeriod(disputePostConclusionAcceptancePeriod)
        .method.toHex(),
      client.api.tx.configuration.setNoShowSlots(noShowSlots).method.toHex(),
      client.api.tx.configuration.setNDelayTranches(nDelayTranches).method.toHex(),
      client.api.tx.configuration.setZerothDelayTrancheWidth(zerothDelayTrancheWidth).method.toHex(),
      client.api.tx.configuration.setNeededApprovals(neededApprovals).method.toHex(),
      client.api.tx.configuration.setRelayVrfModuloSamples(relayVrfModuloSamples).method.toHex(),
    ],
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  pendingConfigs = (await client.api.query.configuration.pendingConfigs()) as Vec<
    ITuple<[u32, PolkadotRuntimeParachainsConfigurationHostConfiguration]>
  >
  const disputePending: PolkadotRuntimeParachainsConfigurationHostConfiguration = pendingConfigs[0][1]
  expect(disputePending.disputePeriod.toNumber()).toBe(disputePeriod)
  expect(disputePending.disputePostConclusionAcceptancePeriod.toNumber()).toBe(disputePostConclusionAcceptancePeriod)
  expect(disputePending.noShowSlots.toNumber()).toBe(noShowSlots)
  expect(disputePending.nDelayTranches.toNumber()).toBe(nDelayTranches)
  expect(disputePending.zerothDelayTrancheWidth.toNumber()).toBe(zerothDelayTrancheWidth)
  expect(disputePending.neededApprovals.toNumber()).toBe(neededApprovals)
  expect(disputePending.relayVrfModuloSamples.toNumber()).toBe(relayVrfModuloSamples)

  // Message Queue Configuration
  const maxUpwardQueueCount = 800000
  const maxUpwardQueueSize = 4194304
  const maxDownwardMessageSize = 60000
  const maxUpwardMessageSize = 80000
  const maxUpwardMessageNumPerCandidate = 25

  await scheduleInlineCallListWithSameOrigin(
    client,
    [
      client.api.tx.configuration.setMaxUpwardQueueCount(maxUpwardQueueCount).method.toHex(),
      client.api.tx.configuration.setMaxUpwardQueueSize(maxUpwardQueueSize).method.toHex(),
      client.api.tx.configuration.setMaxDownwardMessageSize(maxDownwardMessageSize).method.toHex(),
      client.api.tx.configuration.setMaxUpwardMessageSize(maxUpwardMessageSize).method.toHex(),
      client.api.tx.configuration.setMaxUpwardMessageNumPerCandidate(maxUpwardMessageNumPerCandidate).method.toHex(),
    ],
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  pendingConfigs = (await client.api.query.configuration.pendingConfigs()) as Vec<
    ITuple<[u32, PolkadotRuntimeParachainsConfigurationHostConfiguration]>
  >
  const mqPending: PolkadotRuntimeParachainsConfigurationHostConfiguration = pendingConfigs[0][1]
  expect(mqPending.maxUpwardQueueCount.toNumber()).toBe(maxUpwardQueueCount)
  expect(mqPending.maxUpwardQueueSize.toNumber()).toBe(maxUpwardQueueSize)
  expect(mqPending.maxDownwardMessageSize.toNumber()).toBe(maxDownwardMessageSize)
  expect(mqPending.maxUpwardMessageSize.toNumber()).toBe(maxUpwardMessageSize)
  expect(mqPending.maxUpwardMessageNumPerCandidate.toNumber()).toBe(maxUpwardMessageNumPerCandidate)

  // HRMP Configuration
  const hrmpSenderDeposit = 6000000000000n
  const hrmpRecipientDeposit = 6000000000000n
  const hrmpChannelMaxCapacity = 40
  const hrmpChannelMaxTotalSize = 120000
  const hrmpMaxParachainInboundChannels = 40
  const hrmpChannelMaxMessageSize = 120000
  const hrmpMaxParachainOutboundChannels = 40
  const hrmpMaxMessageNumPerCandidate = 15

  await scheduleInlineCallListWithSameOrigin(
    client,
    [
      client.api.tx.configuration.setHrmpSenderDeposit(hrmpSenderDeposit).method.toHex(),
      client.api.tx.configuration.setHrmpRecipientDeposit(hrmpRecipientDeposit).method.toHex(),
      client.api.tx.configuration.setHrmpChannelMaxCapacity(hrmpChannelMaxCapacity).method.toHex(),
      client.api.tx.configuration.setHrmpChannelMaxTotalSize(hrmpChannelMaxTotalSize).method.toHex(),
      client.api.tx.configuration.setHrmpMaxParachainInboundChannels(hrmpMaxParachainInboundChannels).method.toHex(),
      client.api.tx.configuration.setHrmpChannelMaxMessageSize(hrmpChannelMaxMessageSize).method.toHex(),
      client.api.tx.configuration.setHrmpMaxParachainOutboundChannels(hrmpMaxParachainOutboundChannels).method.toHex(),
      client.api.tx.configuration.setHrmpMaxMessageNumPerCandidate(hrmpMaxMessageNumPerCandidate).method.toHex(),
    ],
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  pendingConfigs = (await client.api.query.configuration.pendingConfigs()) as Vec<
    ITuple<[u32, PolkadotRuntimeParachainsConfigurationHostConfiguration]>
  >
  const hrmpPending: PolkadotRuntimeParachainsConfigurationHostConfiguration = pendingConfigs[0][1]
  expect(hrmpPending.hrmpSenderDeposit.toBigInt()).toBe(hrmpSenderDeposit)
  expect(hrmpPending.hrmpRecipientDeposit.toBigInt()).toBe(hrmpRecipientDeposit)
  expect(hrmpPending.hrmpChannelMaxCapacity.toNumber()).toBe(hrmpChannelMaxCapacity)
  expect(hrmpPending.hrmpChannelMaxTotalSize.toNumber()).toBe(hrmpChannelMaxTotalSize)
  expect(hrmpPending.hrmpMaxParachainInboundChannels.toNumber()).toBe(hrmpMaxParachainInboundChannels)
  expect(hrmpPending.hrmpChannelMaxMessageSize.toNumber()).toBe(hrmpChannelMaxMessageSize)
  expect(hrmpPending.hrmpMaxParachainOutboundChannels.toNumber()).toBe(hrmpMaxParachainOutboundChannels)
  expect(hrmpPending.hrmpMaxMessageNumPerCandidate.toNumber()).toBe(hrmpMaxMessageNumPerCandidate)
}

/// ----------
/// Test Trees
/// ----------

export const configurationsE2ETests = <
  TCustom extends Record<string, unknown>,
  TInitStoragesBase extends Record<string, Record<string, any>>,
>(
  chain: Chain<TCustom, TInitStoragesBase>,
  testConfig: TestConfig,
): RootTestTree => ({
  kind: 'describe',
  label: testConfig.testSuiteName,
  children: [
    {
      kind: 'describe',
      label: 'configuration tests',
      children: [
        {
          kind: 'test',
          label: 'configurations test - can read and update configurations',
          testFn: async () => await configurationTest(chain),
        },
      ],
    },
  ],
})
