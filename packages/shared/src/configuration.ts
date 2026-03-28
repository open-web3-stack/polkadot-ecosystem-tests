import { type Chain, defaultAccounts } from '@e2e-test/networks'
import {
  check,
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

import { type TestConfig, testCallsViaForceBatch } from './helpers/index.js'

const devAccounts = defaultAccounts

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
 *
 *     6.4 checks that setMaxRelayParentSessionAge value can be updated
 *
 * 7. Checks that all consistency check violations are rejected:
 *     - Zero checks: groupRotationFrequency, parasAvailabilityPeriod, noShowSlots,
 *       minimumBackingVotes, nDelayTranches, schedulingLookahead
 *     - Hard limit violations: maxCodeSize, maxHeadDataSize, maxPovSize,
 *       maxUpwardMessageSize, hrmpMaxMessageNumPerCandidate, maxUpwardMessageNumPerCandidate,
 *       hrmpMaxParachainOutboundChannels, hrmpMaxParachainInboundChannels, onDemandQueueMaxSize
 *     - Relational checks: minimumValidationUpgradeDelay > parasAvailabilityPeriod,
 *       validationUpgradeDelay > 1
 *
 *     7.1. disabling consistency checks allows all of the above improper values
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

  const coreConfigCalls = [
    // 0
    client.api.tx.configuration.setValidationUpgradeCooldown(validationUpgradeCooldown),
    // 1
    client.api.tx.configuration.setValidationUpgradeDelay(validationUpgradeDelay),
    // 2
    client.api.tx.configuration.setCodeRetentionPeriod(codeRetentionPeriod),
    // 3
    client.api.tx.configuration.setMaxCodeSize(maxCodeSize),
    // 4
    client.api.tx.configuration.setMaxPovSize(maxPovSize),
    // 5
    client.api.tx.configuration.setMaxHeadDataSize(maxHeadDataSize),
    // 6
    client.api.tx.configuration.setCoretimeCores(numCores),
  ]

  await scheduleInlineCallListWithSameOrigin(
    client,
    coreConfigCalls.map((tx) => tx.method.toHex()),
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

  const schedulerConfigCalls = [
    // 8
    client.api.tx.configuration.setGroupRotationFrequency(groupRotationFrequency),
    // 9
    client.api.tx.configuration.setParasAvailabilityPeriod(parasAvailabilityPeriod),
    // 11
    client.api.tx.configuration.setSchedulingLookahead(schedulingLookahead),
    // 12
    client.api.tx.configuration.setMaxValidatorsPerCore(maxValidatorsPerCore),
    // 13
    client.api.tx.configuration.setMaxValidators(maxValidators),
  ]

  await scheduleInlineCallListWithSameOrigin(
    client,
    schedulerConfigCalls.map((tx) => tx.method.toHex()),
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

  const disputeConfigCalls = [
    // 14
    client.api.tx.configuration.setDisputePeriod(disputePeriod),
    // 15
    client.api.tx.configuration.setDisputePostConclusionAcceptancePeriod(disputePostConclusionAcceptancePeriod),
    // 18
    client.api.tx.configuration.setNoShowSlots(noShowSlots),
    // 19
    client.api.tx.configuration.setNDelayTranches(nDelayTranches),
    // 20
    client.api.tx.configuration.setZerothDelayTrancheWidth(zerothDelayTrancheWidth),
    // 21
    client.api.tx.configuration.setNeededApprovals(neededApprovals),
    // 22
    client.api.tx.configuration.setRelayVrfModuloSamples(relayVrfModuloSamples),
  ]

  await scheduleInlineCallListWithSameOrigin(
    client,
    disputeConfigCalls.map((tx) => tx.method.toHex()),
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
  const maxUpwardQueueSize = 1000000
  const maxDownwardMessageSize = 60000
  const maxUpwardMessageSize = 80000
  const maxUpwardMessageNumPerCandidate = 25

  const mqConfigCalls = [
    // 23
    client.api.tx.configuration.setMaxUpwardQueueCount(maxUpwardQueueCount),
    // 24
    client.api.tx.configuration.setMaxUpwardQueueSize(maxUpwardQueueSize),
    // 25
    client.api.tx.configuration.setMaxDownwardMessageSize(maxDownwardMessageSize),
    // 27
    client.api.tx.configuration.setMaxUpwardMessageSize(maxUpwardMessageSize),
    // 28
    client.api.tx.configuration.setMaxUpwardMessageNumPerCandidate(maxUpwardMessageNumPerCandidate),
  ]

  await scheduleInlineCallListWithSameOrigin(
    client,
    mqConfigCalls.map((tx) => tx.method.toHex()),
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

  // 5. HRMP Configuration
  const hrmpSenderDeposit = 6000000000000n
  const hrmpRecipientDeposit = 6000000000000n
  const hrmpChannelMaxCapacity = 40
  const hrmpChannelMaxTotalSize = 120000
  const hrmpMaxParachainInboundChannels = 40
  const hrmpChannelMaxMessageSize = 120000
  const hrmpMaxParachainOutboundChannels = 40
  const hrmpMaxMessageNumPerCandidate = 15

  const hrmpConfigCalls = [
    // 29
    client.api.tx.configuration.setHrmpOpenRequestTtl(0),
    // 30
    client.api.tx.configuration.setHrmpSenderDeposit(hrmpSenderDeposit),
    // 31
    client.api.tx.configuration.setHrmpRecipientDeposit(hrmpRecipientDeposit),
    // 32
    client.api.tx.configuration.setHrmpChannelMaxCapacity(hrmpChannelMaxCapacity),
    // 33
    client.api.tx.configuration.setHrmpChannelMaxTotalSize(hrmpChannelMaxTotalSize),
    // 34
    client.api.tx.configuration.setHrmpMaxParachainInboundChannels(hrmpMaxParachainInboundChannels),
    // 36
    client.api.tx.configuration.setHrmpChannelMaxMessageSize(hrmpChannelMaxMessageSize),
    // 37
    client.api.tx.configuration.setHrmpMaxParachainOutboundChannels(hrmpMaxParachainOutboundChannels),
    // 39
    client.api.tx.configuration.setHrmpMaxMessageNumPerCandidate(hrmpMaxMessageNumPerCandidate),
  ]

  await scheduleInlineCallListWithSameOrigin(
    client,
    hrmpConfigCalls.map((tx) => tx.method.toHex()),
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
  const maxApprovalCoalesceCount = 8

  const advancedConfigCalls = [
    // 42
    client.api.tx.configuration.setPvfVotingTtl(pvfVotingTtl),
    // 43
    client.api.tx.configuration.setMinimumValidationUpgradeDelay(minimumValidationUpgradeDelay),
    // 52
    client.api.tx.configuration.setMinimumBackingVotes(minimumBackingVotes),
    // 45
    client.api.tx.configuration.setAsyncBackingParams({ maxCandidateDepth, allowedAncestryLen }),
    // 46
    client.api.tx.configuration.setExecutorParams([
      { MaxMemoryPages: 8192 },
      { PvfExecTimeout: ['Backing', 3000] },
      { PvfExecTimeout: ['Approval', 20000] },
    ]),
    // 54
    client.api.tx.configuration.setApprovalVotingParams({ maxApprovalCoalesceCount }),
    // 44
    client.api.tx.configuration.setBypassConsistencyCheck(false),
    // 53
    client.api.tx.configuration.setNodeFeature(4, true),
  ]

  await scheduleInlineCallListWithSameOrigin(
    client,
    advancedConfigCalls.map((tx) => tx.method.toHex()),
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

  const onDemandConfigCalls = [
    // 47
    client.api.tx.configuration.setOnDemandBaseFee(onDemandBaseFee),
    // 48
    client.api.tx.configuration.setOnDemandFeeVariability(onDemandFeeVariability),
    // 49
    client.api.tx.configuration.setOnDemandQueueMaxSize(onDemandQueueMaxSize),
    // 50
    client.api.tx.configuration.setOnDemandTargetQueueUtilization(onDemandTargetQueueUtilization),
  ]

  await scheduleInlineCallListWithSameOrigin(
    client,
    onDemandConfigCalls.map((tx) => tx.method.toHex()),
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

  const newSchedulerParamsArg = {
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
  }

  // 55
  const setSchedulerParamsCall = client.api.tx.configuration.setSchedulerParams(newSchedulerParamsArg)

  await scheduleInlineCallWithOrigin(
    client,
    setSchedulerParamsCall.method.toHex(),
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

  // 6.4 checks that setMaxRelayParentSessionAge value can be updated
  const maxRelayParentSessionAge = 5

  // 56
  const setMaxRelayParentSessionAgeCall =
    client.api.tx.configuration.setMaxRelayParentSessionAge(maxRelayParentSessionAge)

  await scheduleInlineCallWithOrigin(
    client,
    setMaxRelayParentSessionAgeCall.method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  pendingConfigs = (await client.api.query.configuration.pendingConfigs()) as Vec<
    ITuple<[u32, PolkadotRuntimeParachainsConfigurationHostConfiguration]>
  >
  const maxRelayParentSessionAgePending: PolkadotRuntimeParachainsConfigurationHostConfiguration = pendingConfigs[0][1]
  await check(maxRelayParentSessionAgePending).redact({ number: 1 }).toMatchSnapshot('maxRelayParentSessionAge updated')

  // 7. Assert that consistency checks disallows improper config values
  const improperConfigCalls = [
    // Zero checks
    client.api.tx.configuration.setGroupRotationFrequency(0),
    client.api.tx.configuration.setParasAvailabilityPeriod(0),
    client.api.tx.configuration.setNoShowSlots(0),
    client.api.tx.configuration.setMinimumBackingVotes(0),
    client.api.tx.configuration.setNDelayTranches(0),
    client.api.tx.configuration.setSchedulingLookahead(0),
    // Hard limit violations
    client.api.tx.configuration.setMaxCodeSize(3_145_729), // > MAX_CODE_SIZE (3,145,728)
    client.api.tx.configuration.setMaxHeadDataSize(1_048_577), // > MAX_HEAD_DATA_SIZE (1,048,576)
    client.api.tx.configuration.setMaxPovSize(16_777_217), // > POV_SIZE_HARD_LIMIT (16,777,216)
    client.api.tx.configuration.setMaxUpwardMessageSize(131_073), // > MAX_UPWARD_MESSAGE_SIZE_BOUND (131,072)
    client.api.tx.configuration.setHrmpMaxMessageNumPerCandidate(16_385), // > MAX_HORIZONTAL_MESSAGE_NUM (16,384)
    client.api.tx.configuration.setMaxUpwardMessageNumPerCandidate(16_385), // > MAX_UPWARD_MESSAGE_NUM (16,384)
    client.api.tx.configuration.setHrmpMaxParachainOutboundChannels(129), // > HRMP_MAX_OUTBOUND_CHANNELS_BOUND (128)
    client.api.tx.configuration.setHrmpMaxParachainInboundChannels(129), // > HRMP_MAX_INBOUND_CHANNELS_BOUND (128)
    client.api.tx.configuration.setOnDemandQueueMaxSize(10_001), // > ON_DEMAND_MAX_QUEUE_MAX_SIZE (10,000)
    // Relational checks
    client.api.tx.configuration.setMinimumValidationUpgradeDelay(1), // must be > paras_availability_period
    client.api.tx.configuration.setValidationUpgradeDelay(1), // must be > 1
  ]

  await scheduleInlineCallListWithSameOrigin(
    client,
    improperConfigCalls.map((tx) => tx.method.toHex()),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  pendingConfigs = (await client.api.query.configuration.pendingConfigs()) as Vec<
    ITuple<[u32, PolkadotRuntimeParachainsConfigurationHostConfiguration]>
  >

  const improperPending: PolkadotRuntimeParachainsConfigurationHostConfiguration = pendingConfigs[0][1]
  const improperSchedulerParams = improperPending.schedulerParams as PolkadotPrimitivesV8SchedulerParams

  // Zero checks — all should retain their previous valid values
  expect(improperSchedulerParams.groupRotationFrequency.toNumber()).toBe(schedulerGroupRotationFrequency)
  expect(improperSchedulerParams.parasAvailabilityPeriod.toNumber()).toBe(schedulerParasAvailabilityPeriod)
  expect(improperPending.noShowSlots.toNumber()).toBe(noShowSlots)
  expect(improperPending.minimumBackingVotes.toNumber()).toBe(minimumBackingVotes)
  expect(improperPending.nDelayTranches.toNumber()).toBe(nDelayTranches)
  expect(improperSchedulerParams.lookahead.toNumber()).toBe(schedulerLookahead)

  // Hard limit violations — all should retain their previous valid values
  expect(improperPending.maxCodeSize.toNumber()).toBe(maxCodeSize)
  expect(improperPending.maxHeadDataSize.toNumber()).toBe(maxHeadDataSize)
  expect(improperPending.maxPovSize.toNumber()).toBe(maxPovSize)
  expect(improperPending.maxUpwardMessageSize.toNumber()).toBe(maxUpwardMessageSize)
  expect(improperPending.hrmpMaxMessageNumPerCandidate.toNumber()).toBe(hrmpMaxMessageNumPerCandidate)
  expect(improperPending.maxUpwardMessageNumPerCandidate.toNumber()).toBe(maxUpwardMessageNumPerCandidate)
  expect(improperPending.hrmpMaxParachainOutboundChannels.toNumber()).toBe(hrmpMaxParachainOutboundChannels)
  expect(improperPending.hrmpMaxParachainInboundChannels.toNumber()).toBe(hrmpMaxParachainInboundChannels)
  expect(improperSchedulerParams.onDemandQueueMaxSize.toNumber()).toBe(schedulerOnDemandQueueMaxSize)

  // Relational checks — all should retain their previous valid values
  expect(improperPending.minimumValidationUpgradeDelay.toNumber()).toBe(minimumValidationUpgradeDelay)
  expect(improperPending.validationUpgradeDelay.toNumber()).toBe(validationUpgradeDelay)

  // 7.1. Assert that disabling consistency checks allows improper config values
  await scheduleInlineCallWithOrigin(
    client,
    client.api.tx.configuration.setBypassConsistencyCheck(true).method.toHex(),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  await scheduleInlineCallListWithSameOrigin(
    client,
    improperConfigCalls.map((tx) => tx.method.toHex()),
    { system: 'Root' },
    chain.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  pendingConfigs = (await client.api.query.configuration.pendingConfigs()) as Vec<
    ITuple<[u32, PolkadotRuntimeParachainsConfigurationHostConfiguration]>
  >

  const consistencyBypassedPending: PolkadotRuntimeParachainsConfigurationHostConfiguration = pendingConfigs[0][1]
  const bypassedSchedulerParams = consistencyBypassedPending.schedulerParams as PolkadotPrimitivesV8SchedulerParams

  // Zero checks — all should now hold the improper (zero) values
  expect(bypassedSchedulerParams.groupRotationFrequency.toNumber()).toBe(0)
  expect(bypassedSchedulerParams.parasAvailabilityPeriod.toNumber()).toBe(0)
  expect(consistencyBypassedPending.noShowSlots.toNumber()).toBe(0)
  expect(consistencyBypassedPending.minimumBackingVotes.toNumber()).toBe(0)
  expect(consistencyBypassedPending.nDelayTranches.toNumber()).toBe(0)
  expect(bypassedSchedulerParams.lookahead.toNumber()).toBe(0)

  // Hard limit violations — all should now hold the over-limit values
  expect(consistencyBypassedPending.maxCodeSize.toNumber()).toBe(3_145_729)
  expect(consistencyBypassedPending.maxHeadDataSize.toNumber()).toBe(1_048_577)
  expect(consistencyBypassedPending.maxPovSize.toNumber()).toBe(16_777_217)
  expect(consistencyBypassedPending.maxUpwardMessageSize.toNumber()).toBe(131_073)
  expect(consistencyBypassedPending.hrmpMaxMessageNumPerCandidate.toNumber()).toBe(16_385)
  expect(consistencyBypassedPending.maxUpwardMessageNumPerCandidate.toNumber()).toBe(16_385)
  expect(consistencyBypassedPending.hrmpMaxParachainOutboundChannels.toNumber()).toBe(129)
  expect(consistencyBypassedPending.hrmpMaxParachainInboundChannels.toNumber()).toBe(129)
  expect(bypassedSchedulerParams.onDemandQueueMaxSize.toNumber()).toBe(10_001)

  // Relational checks — all should now hold the relational-violating values
  expect(consistencyBypassedPending.minimumValidationUpgradeDelay.toNumber()).toBe(1)
  expect(consistencyBypassedPending.validationUpgradeDelay.toNumber()).toBe(1)

  // 8. Assert that tx should fail with signed origin
  const batchCalls = [
    ...coreConfigCalls,
    ...schedulerConfigCalls,
    ...disputeConfigCalls,
    ...mqConfigCalls,
    ...hrmpConfigCalls,
    ...advancedConfigCalls,
    ...onDemandConfigCalls,
    setSchedulerParamsCall,
    setMaxRelayParentSessionAgeCall,
  ]

  await testCallsViaForceBatch(client, 'Configuration', batchCalls, devAccounts.alice, 'NotFiltered')
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
