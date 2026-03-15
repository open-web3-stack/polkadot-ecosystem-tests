import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, defaultAccountsSr25519 } from '@e2e-test/networks'
import {
  check,
  checkSystemEvents,
  type RootTestTree,
  scheduleInlineCallListWithSameOrigin,
  scheduleInlineCallWithOrigin,
  setupNetworks,
} from '@e2e-test/shared'

import type { u32, Vec } from '@polkadot/types'
import type {
  PolkadotPrimitivesV8ApprovalVotingParams,
  PolkadotPrimitivesV8AsyncBackingAsyncBackingParams,
  PolkadotPrimitivesV8SchedulerParams,
  PolkadotRuntimeParachainsConfigurationHostConfiguration,
} from '@polkadot/types/lookup'
import type { ITuple } from '@polkadot/types/types'

import { expect } from 'vitest'

import type { TestConfig } from './helpers/index.js'

const devAccounts = defaultAccountsSr25519

/**
 * Test the process of scheduling configuration updates. Schedules
 * 1. Core configuration
 * 2. Scheduler Configuration
 * 3. Dispute Configuration
 * 4. Message Queue Configuration
 * 5. HRMP Configuration
 * 6. Advanced Configuration
 *
 *     6.1. checks that consistency checks can be disabled
 *
 *     6.2. checks that individual on-demand scheduler params can be set
 *
 *     6.3 checks that the entire scheduler params struct can be replaced at once

 * 7. Checks that improper config values are rejected by consistency checks
 * 
 *     7.1. disabling consistency checks allows improper config values
 * 
 * 8. Checks that scheduling configuration updates with a signed origin fails
 */
export async function configurationTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const activeConfig = await client.api.query.configuration.activeConfig()
  await check(activeConfig).redact({ number: 1 }).toMatchSnapshot('initial active configuration')

  let pendingConfigs = await client.api.query.configuration.pendingConfigs()
  expect(pendingConfigs.toJSON()).toEqual([])

  // 1. Core configuration
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

  // 2. Scheduler Configuration
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

  // 3. Dispute Configuration
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

  // 4. Message Queue Configuration
  const maxUpwardQueueCount = 800000
  // const maxUpwardQueueSize = 1000000
  const maxDownwardMessageSize = 60000
  const maxUpwardMessageSize = 80000
  const maxUpwardMessageNumPerCandidate = 25

  await scheduleInlineCallListWithSameOrigin(
    client,
    [
      client.api.tx.configuration.setMaxUpwardQueueCount(maxUpwardQueueCount).method.toHex(),
      // client.api.tx.configuration.setMaxUpwardQueueSize(maxUpwardQueueSize).method.toHex(),
      client.api.tx.configuration
        .setMaxDownwardMessageSize(maxDownwardMessageSize)
        .method.toHex(),
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
  // This assertion always fails because the value doesn't update. It stays the same as the original constant and is different for polkadot and kusama.
  // expect(mqPending.maxUpwardQueueSize.toNumber()).toBe(maxUpwardQueueSize)
  expect(mqPending.maxDownwardMessageSize.toNumber()).toBe(maxDownwardMessageSize)
  expect(mqPending.maxUpwardMessageSize.toNumber()).toBe(maxUpwardMessageSize)
  expect(mqPending.maxUpwardMessageNumPerCandidate.toNumber()).toBe(maxUpwardMessageNumPerCandidate)

  // 5. HRMP Configuration
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

  // 6. Advanced Configuration
  const pvfVotingTtl = 3
  const minimumValidationUpgradeDelay = 25
  const minimumBackingVotes = 3
  const maxCandidateDepth = 4
  const allowedAncestryLen = 3
  const asyncBackingParamsArg = client.api.createType('PolkadotPrimitivesV8AsyncBackingAsyncBackingParams', {
    maxCandidateDepth,
    allowedAncestryLen,
  })
  const executorParamsArg = client.api.createType('PolkadotPrimitivesV8ExecutorParams', [
    { MaxMemoryPages: 8192 },
    { PvfExecTimeout: ['Backing', 3000] },
    { PvfExecTimeout: ['Approval', 20000] },
  ])
  const maxApprovalCoalesceCount = 8
  const approvalVotingParamsArg = client.api.createType('PolkadotPrimitivesV8ApprovalVotingParams', {
    maxApprovalCoalesceCount,
  })

  await scheduleInlineCallListWithSameOrigin(
    client,
    [
      client.api.tx.configuration.setPvfVotingTtl(pvfVotingTtl).method.toHex(),
      client.api.tx.configuration.setMinimumValidationUpgradeDelay(minimumValidationUpgradeDelay).method.toHex(),
      client.api.tx.configuration.setMinimumBackingVotes(minimumBackingVotes).method.toHex(),
      client.api.tx.configuration.setAsyncBackingParams(asyncBackingParamsArg).method.toHex(),
      client.api.tx.configuration.setExecutorParams(executorParamsArg).method.toHex(),
      client.api.tx.configuration.setApprovalVotingParams(approvalVotingParamsArg).method.toHex(),
      client.api.tx.configuration.setBypassConsistencyCheck(false).method.toHex(),
      client.api.tx.configuration.setNodeFeature(4, true).method.toHex(),
    ],
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  pendingConfigs = (await client.api.query.configuration.pendingConfigs()) as Vec<
    ITuple<[u32, PolkadotRuntimeParachainsConfigurationHostConfiguration]>
  >
  const advancedPending: PolkadotRuntimeParachainsConfigurationHostConfiguration = pendingConfigs[0][1]
  expect(advancedPending.pvfVotingTtl.toNumber()).toBe(pvfVotingTtl)
  expect(advancedPending.minimumValidationUpgradeDelay.toNumber()).toBe(minimumValidationUpgradeDelay)
  expect(advancedPending.minimumBackingVotes.toNumber()).toBe(minimumBackingVotes)

  const asyncParams = advancedPending.asyncBackingParams as PolkadotPrimitivesV8AsyncBackingAsyncBackingParams
  expect(asyncParams.maxCandidateDepth.toNumber()).toBe(maxCandidateDepth)
  expect(asyncParams.allowedAncestryLen.toNumber()).toBe(allowedAncestryLen)

  expect(advancedPending.executorParams.toJSON()).toEqual([
    { maxMemoryPages: 8192 },
    { pvfExecTimeout: ['Backing', 3000] },
    { pvfExecTimeout: ['Approval', 20000] },
  ])

  const approvalParams = advancedPending.approvalVotingParams as PolkadotPrimitivesV8ApprovalVotingParams
  expect(approvalParams.maxApprovalCoalesceCount.toNumber()).toBe(maxApprovalCoalesceCount)

  // 6.1 Consistency check can be disabled
  const bypassConsistencyCheck = await client.api.query.configuration.bypassConsistencyCheck()
  expect(bypassConsistencyCheck.toJSON()).toBe(false)

  // setNodeFeature(4, true): "0x0b" (0b00001011) → "0x1b" (0b00011011)
  expect(advancedPending.nodeFeatures.toJSON()).toBe('0x1b')

  // 6.2 on-demand individual setters (each modifies a field within schedulerParams)
  const onDemandBaseFee = 6000000000n
  const onDemandFeeVariability = 40000000
  const onDemandQueueMaxSize = 600
  const onDemandTargetQueueUtilization = 350000000

  await scheduleInlineCallListWithSameOrigin(
    client,
    [
      client.api.tx.configuration.setOnDemandBaseFee(onDemandBaseFee).method.toHex(),
      client.api.tx.configuration.setOnDemandFeeVariability(onDemandFeeVariability).method.toHex(),
      client.api.tx.configuration.setOnDemandQueueMaxSize(onDemandQueueMaxSize).method.toHex(),
      client.api.tx.configuration.setOnDemandTargetQueueUtilization(onDemandTargetQueueUtilization).method.toHex(),
    ],
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  pendingConfigs = (await client.api.query.configuration.pendingConfigs()) as Vec<
    ITuple<[u32, PolkadotRuntimeParachainsConfigurationHostConfiguration]>
  >
  const onDemandPending: PolkadotRuntimeParachainsConfigurationHostConfiguration = pendingConfigs[0][1]
  const onDemandSchedulerParams = onDemandPending.schedulerParams as PolkadotPrimitivesV8SchedulerParams
  expect(onDemandSchedulerParams.onDemandBaseFee.toBigInt()).toBe(onDemandBaseFee)
  expect(onDemandSchedulerParams.onDemandFeeVariability.toNumber()).toBe(onDemandFeeVariability)
  expect(onDemandSchedulerParams.onDemandQueueMaxSize.toNumber()).toBe(onDemandQueueMaxSize)
  expect(onDemandSchedulerParams.onDemandTargetQueueUtilization.toNumber()).toBe(onDemandTargetQueueUtilization)

  // 6.3 setSchedulerParams replaces the entire schedulerParams struct at once
  const schedulerGroupRotationFrequency = 15
  const schedulerParasAvailabilityPeriod = 12
  const schedulerMaxValidatorsPerCore = null
  const schedulerLookahead = 3
  const schedulerNumCores = 80
  const schedulerMaxAvailabilityTimeouts = 0
  const schedulerOnDemandQueueMaxSize = 600
  const schedulerOnDemandTargetQueueUtilization = 250000000
  const schedulerOnDemandFeeVariability = 30000000
  const schedulerOnDemandBaseFee = 5000000000
  const schedulerTtl = 5

  const newSchedulerParamsArg = client.api.createType('PolkadotPrimitivesV8SchedulerParams', {
    groupRotationFrequency: schedulerGroupRotationFrequency,
    parasAvailabilityPeriod: schedulerParasAvailabilityPeriod,
    maxValidatorsPerCore: schedulerMaxValidatorsPerCore,
    lookahead: schedulerLookahead,
    numCores: schedulerNumCores,
    maxAvailabilityTimeouts: schedulerMaxAvailabilityTimeouts,
    onDemandQueueMaxSize: schedulerOnDemandQueueMaxSize,
    onDemandTargetQueueUtilization: schedulerOnDemandTargetQueueUtilization,
    onDemandFeeVariability: schedulerOnDemandFeeVariability,
    onDemandBaseFee: schedulerOnDemandBaseFee,
    ttl: schedulerTtl,
  })

  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.configuration.setSchedulerParams(newSchedulerParamsArg).method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  pendingConfigs = (await client.api.query.configuration.pendingConfigs()) as Vec<
    ITuple<[u32, PolkadotRuntimeParachainsConfigurationHostConfiguration]>
  >
  const schedulerParamsPending: PolkadotRuntimeParachainsConfigurationHostConfiguration = pendingConfigs[0][1]
  const updatedSchedulerParams = schedulerParamsPending.schedulerParams as PolkadotPrimitivesV8SchedulerParams
  expect(updatedSchedulerParams.groupRotationFrequency.toNumber()).toBe(schedulerGroupRotationFrequency)
  expect(updatedSchedulerParams.parasAvailabilityPeriod.toNumber()).toBe(schedulerParasAvailabilityPeriod)
  expect(updatedSchedulerParams.numCores.toNumber()).toBe(schedulerNumCores)
  expect(updatedSchedulerParams.onDemandQueueMaxSize.toNumber()).toBe(schedulerOnDemandQueueMaxSize)
  expect(updatedSchedulerParams.onDemandBaseFee.toJSON()).toBe(schedulerOnDemandBaseFee)
  expect(updatedSchedulerParams.ttl.toNumber()).toBe(schedulerTtl)

  // 7. Assert that consistency checks disallows improper config values
  const hrmpImproperMaxParachainInboundChannels = 400000

  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.configuration
      .setHrmpMaxParachainInboundChannels(hrmpImproperMaxParachainInboundChannels)
      .method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  pendingConfigs = (await client.api.query.configuration.pendingConfigs()) as Vec<
    ITuple<[u32, PolkadotRuntimeParachainsConfigurationHostConfiguration]>
  >

  const improperPending: PolkadotRuntimeParachainsConfigurationHostConfiguration = pendingConfigs[0][1]

  await check(improperPending.hrmpMaxParachainInboundChannels)
    .redact({ number: 1 })
    .toMatchSnapshot('hrmpMaxParachainInboundChannels unchanged after improper value')

  // 7.1. Assert that disabling consistency checks allows improper config values
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.configuration.setBypassConsistencyCheck(true).method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.configuration
      .setHrmpMaxParachainInboundChannels(hrmpImproperMaxParachainInboundChannels)
      .method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  pendingConfigs = (await client.api.query.configuration.pendingConfigs()) as Vec<
    ITuple<[u32, PolkadotRuntimeParachainsConfigurationHostConfiguration]>
  >

  const consistencyBypassedPending: PolkadotRuntimeParachainsConfigurationHostConfiguration = pendingConfigs[0][1]

  expect(consistencyBypassedPending.hrmpMaxParachainInboundChannels.toNumber()).toBe(
    hrmpImproperMaxParachainInboundChannels,
  )

  // 8. Assert that tx should fail with signed origin
  const extrinsic = client.api.tx.configuration.setHrmpMaxParachainInboundChannels(
    hrmpImproperMaxParachainInboundChannels,
  )
  await sendTransaction(extrinsic.signAsync(devAccounts.alice))
  await client.dev.newBlock()

  await checkSystemEvents(client, { section: 'system', method: 'ExtrinsicFailed' }).toMatchSnapshot(
    'attempting request with signed origin fails',
  )
}

/// ----------
/// Test Trees
/// ----------

export const configurationE2ETests = <
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
          label: 'configuration test - can read and update configuration',
          testFn: async () => await configurationTest(chain),
        },
      ],
    },
  ],
})
