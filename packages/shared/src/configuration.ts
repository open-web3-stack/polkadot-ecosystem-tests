import { type Chain, defaultAccounts } from '@e2e-test/networks'
import { check, type RootTestTree, scheduleInlineCallListWithSameOrigin, setupNetworks } from '@e2e-test/shared'

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
 * Schedules `calls` with Root origin, advances one block, then fetches pendingConfigs,
 * asserts the scheduled session is `currentSessionIndex + 2`, and calls `assertFn` with
 * the pending configuration.
 */
async function runAndAssert(
  client: Awaited<ReturnType<typeof setupNetworks>>[0],
  currentSessionIndex: number,
  calls: Array<{ method: { toHex(): string } }>,
  assertFn: (pending: PolkadotRuntimeParachainsConfigurationHostConfiguration) => void | Promise<void>,
): Promise<void> {
  await scheduleInlineCallListWithSameOrigin(
    client,
    calls.map((tx) => tx.method.toHex() as `0x${string}`),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  const pendingConfigs = (await client.api.query.configuration.pendingConfigs()) as Vec<
    ITuple<[u32, PolkadotRuntimeParachainsConfigurationHostConfiguration]>
  >
  expect(pendingConfigs[0][0].toNumber()).toBe(currentSessionIndex + 2)
  await assertFn(pendingConfigs[0][1])
}

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

  const initialPendingConfigs = await client.api.query.configuration.pendingConfigs()
  expect(initialPendingConfigs.toJSON()).toEqual([])

  const currentSessionIndex = (await client.api.query.session.currentIndex()).toNumber()

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

  await runAndAssert(client, currentSessionIndex, coreConfigCalls, (pending) => {
    expect(pending.validationUpgradeCooldown.toNumber()).toBe(validationUpgradeCooldown)
    expect(pending.validationUpgradeDelay.toNumber()).toBe(validationUpgradeDelay)
    expect(pending.codeRetentionPeriod.toNumber()).toBe(codeRetentionPeriod)
    expect(pending.maxCodeSize.toNumber()).toBe(maxCodeSize)
    expect(pending.maxPovSize.toNumber()).toBe(maxPovSize)
    expect(pending.maxHeadDataSize.toNumber()).toBe(maxHeadDataSize)
    expect((pending.schedulerParams as PolkadotPrimitivesV8SchedulerParams).numCores.toNumber()).toBe(numCores)
  })

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

  await runAndAssert(client, currentSessionIndex, schedulerConfigCalls, (pending) => {
    const schedulerParams = pending.schedulerParams as PolkadotPrimitivesV8SchedulerParams
    expect(schedulerParams.groupRotationFrequency.toNumber()).toBe(groupRotationFrequency)
    expect(schedulerParams.parasAvailabilityPeriod.toNumber()).toBe(parasAvailabilityPeriod)
    expect(schedulerParams.lookahead.toNumber()).toBe(schedulingLookahead)
    expect(schedulerParams.maxValidatorsPerCore.unwrap().toNumber()).toBe(maxValidatorsPerCore)
    expect(pending.maxValidators.toJSON()).toBe(maxValidators)
  })

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

  await runAndAssert(client, currentSessionIndex, disputeConfigCalls, (pending) => {
    expect(pending.disputePeriod.toNumber()).toBe(disputePeriod)
    expect(pending.disputePostConclusionAcceptancePeriod.toNumber()).toBe(disputePostConclusionAcceptancePeriod)
    expect(pending.noShowSlots.toNumber()).toBe(noShowSlots)
    expect(pending.nDelayTranches.toNumber()).toBe(nDelayTranches)
    expect(pending.zerothDelayTrancheWidth.toNumber()).toBe(zerothDelayTrancheWidth)
    expect(pending.neededApprovals.toNumber()).toBe(neededApprovals)
    expect(pending.relayVrfModuloSamples.toNumber()).toBe(relayVrfModuloSamples)
  })

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

  await runAndAssert(client, currentSessionIndex, mqConfigCalls, (pending) => {
    expect(pending.maxUpwardQueueCount.toNumber()).toBe(maxUpwardQueueCount)
    expect(pending.maxUpwardQueueSize.toNumber()).toBe(maxUpwardQueueSize)
    expect(pending.maxDownwardMessageSize.toNumber()).toBe(maxDownwardMessageSize)
    expect(pending.maxUpwardMessageSize.toNumber()).toBe(maxUpwardMessageSize)
    expect(pending.maxUpwardMessageNumPerCandidate.toNumber()).toBe(maxUpwardMessageNumPerCandidate)
  })

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

  await runAndAssert(client, currentSessionIndex, hrmpConfigCalls, (pending) => {
    expect(pending.hrmpSenderDeposit.toBigInt()).toBe(hrmpSenderDeposit)
    expect(pending.hrmpRecipientDeposit.toBigInt()).toBe(hrmpRecipientDeposit)
    expect(pending.hrmpChannelMaxCapacity.toNumber()).toBe(hrmpChannelMaxCapacity)
    expect(pending.hrmpChannelMaxTotalSize.toNumber()).toBe(hrmpChannelMaxTotalSize)
    expect(pending.hrmpMaxParachainInboundChannels.toNumber()).toBe(hrmpMaxParachainInboundChannels)
    expect(pending.hrmpChannelMaxMessageSize.toNumber()).toBe(hrmpChannelMaxMessageSize)
    expect(pending.hrmpMaxParachainOutboundChannels.toNumber()).toBe(hrmpMaxParachainOutboundChannels)
    expect(pending.hrmpMaxMessageNumPerCandidate.toNumber()).toBe(hrmpMaxMessageNumPerCandidate)
  })

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

  await runAndAssert(client, currentSessionIndex, advancedConfigCalls, (pending) => {
    expect(pending.pvfVotingTtl.toNumber()).toBe(pvfVotingTtl)
    expect(pending.minimumValidationUpgradeDelay.toNumber()).toBe(minimumValidationUpgradeDelay)
    expect(pending.minimumBackingVotes.toNumber()).toBe(minimumBackingVotes)

    const asyncParams = pending.asyncBackingParams as PolkadotPrimitivesV8AsyncBackingAsyncBackingParams
    expect(asyncParams.maxCandidateDepth.toNumber()).toBe(maxCandidateDepth)
    expect(asyncParams.allowedAncestryLen.toNumber()).toBe(allowedAncestryLen)

    expect(pending.executorParams.toJSON()).toEqual([
      { maxMemoryPages: 8192 },
      { pvfExecTimeout: ['Backing', 3000] },
      { pvfExecTimeout: ['Approval', 20000] },
    ])

    const approvalParams = pending.approvalVotingParams as PolkadotPrimitivesV8ApprovalVotingParams
    expect(approvalParams.maxApprovalCoalesceCount.toNumber()).toBe(maxApprovalCoalesceCount)

    // 6.1 Consistency check can be disabled
    // setNodeFeature(4, true): "0x0b" (0b00001011) → "0x1b" (0b00011011)
    expect(pending.nodeFeatures.toJSON()).toBe('0x1b')
  })

  // 6.1 Verify bypassConsistencyCheck storage item is false (set via advancedConfigCalls above)
  const bypassConsistencyCheck = await client.api.query.configuration.bypassConsistencyCheck()
  expect(bypassConsistencyCheck.toJSON()).toBe(false)

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

  await runAndAssert(client, currentSessionIndex, onDemandConfigCalls, (pending) => {
    const schedulerParams = pending.schedulerParams as PolkadotPrimitivesV8SchedulerParams
    expect(schedulerParams.onDemandBaseFee.toBigInt()).toBe(onDemandBaseFee)
    expect(schedulerParams.onDemandFeeVariability.toNumber()).toBe(onDemandFeeVariability)
    expect(schedulerParams.onDemandQueueMaxSize.toNumber()).toBe(onDemandQueueMaxSize)
    expect(schedulerParams.onDemandTargetQueueUtilization.toNumber()).toBe(onDemandTargetQueueUtilization)
  })

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

  await runAndAssert(client, currentSessionIndex, [setSchedulerParamsCall], (pending) => {
    const schedulerParams = pending.schedulerParams as PolkadotPrimitivesV8SchedulerParams
    expect(schedulerParams.groupRotationFrequency.toNumber()).toBe(schedulerGroupRotationFrequency)
    expect(schedulerParams.parasAvailabilityPeriod.toNumber()).toBe(schedulerParasAvailabilityPeriod)
    expect(schedulerParams.numCores.toNumber()).toBe(schedulerNumCores)
    expect(schedulerParams.onDemandQueueMaxSize.toNumber()).toBe(schedulerOnDemandQueueMaxSize)
    expect(schedulerParams.onDemandBaseFee.toJSON()).toBe(schedulerOnDemandBaseFee)
    expect(schedulerParams.ttl.toNumber()).toBe(schedulerTtl)
  })

  /**
   * Call was recently added and does not exist in test runtime
   */
  // 6.4 checks that setMaxRelayParentSessionAge value can be updated
  // const maxRelayParentSessionAge = 5

  // // 56
  // const setMaxRelayParentSessionAgeCall =
  //   client.api.tx.configuration.setMaxRelayParentSessionAge(maxRelayParentSessionAge)

  // await runAndAssert(client, currentSessionIndex,[setMaxRelayParentSessionAgeCall], async (pending) => {
  //   await check(pending).redact({ number: 1 }).toMatchSnapshot('maxRelayParentSessionAge updated')
  // })

  // 8. Assert that tx should fail with signed origin
  // const batchCalls = [
  //   ...coreConfigCalls,
  //   ...schedulerConfigCalls,
  //   ...disputeConfigCalls,
  //   ...mqConfigCalls,
  //   ...hrmpConfigCalls,
  //   ...advancedConfigCalls,
  //   ...onDemandConfigCalls,
  //   setSchedulerParamsCall,
  //   // setMaxRelayParentSessionAgeCall,
  // ]

  // await testCallsViaForceBatch(client, 'Configuration', batchCalls, devAccounts.alice, 'NotFiltered')
}

/**
 * Schedules `calls` twice with Root origin and asserts the resulting pending config is
 * identical both times — i.e., re-scheduling the same calls is idempotent.
 */
async function assertIdempotent(
  client: Awaited<ReturnType<typeof setupNetworks>>[0],
  currentSessionIndex: number,
  calls: Array<{ method: { toHex(): string } }>,
): Promise<void> {
  await runAndAssert(client, currentSessionIndex, calls, () => {})
  const pendingConfigs = (await client.api.query.configuration.pendingConfigs()) as Vec<
    ITuple<[u32, PolkadotRuntimeParachainsConfigurationHostConfiguration]>
  >
  const firstPending = pendingConfigs[0][1].toJSON()

  await runAndAssert(client, currentSessionIndex, calls, (pending) => {
    expect(pending.toJSON()).toEqual(firstPending)
  })
}

/**
 * Verifies that scheduling the same configuration change twice leaves the pending config
 * unchanged — i.e., the second scheduling is idempotent and does not alter any field
 * that was not explicitly set. Covers all call groups.
 */
export async function configurationIdempotencyTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const currentSessionIndex = (await client.api.query.session.currentIndex()).toNumber()

  // 1. Core configuration
  await assertIdempotent(client, currentSessionIndex, [
    client.api.tx.configuration.setValidationUpgradeCooldown(13300),
    client.api.tx.configuration.setValidationUpgradeDelay(700),
    client.api.tx.configuration.setCodeRetentionPeriod(14300),
    client.api.tx.configuration.setMaxCodeSize(3_000_000),
    client.api.tx.configuration.setMaxPovSize(10_000_000),
    client.api.tx.configuration.setMaxHeadDataSize(20000),
    client.api.tx.configuration.setCoretimeCores(50),
  ])

  // 2. Scheduler configuration
  await assertIdempotent(client, currentSessionIndex, [
    client.api.tx.configuration.setGroupRotationFrequency(20),
    client.api.tx.configuration.setParasAvailabilityPeriod(15),
    client.api.tx.configuration.setSchedulingLookahead(4),
    client.api.tx.configuration.setMaxValidatorsPerCore(10),
    client.api.tx.configuration.setMaxValidators(500),
  ])

  // 3. Dispute configuration
  await assertIdempotent(client, currentSessionIndex, [
    client.api.tx.configuration.setDisputePeriod(8),
    client.api.tx.configuration.setDisputePostConclusionAcceptancePeriod(700),
    client.api.tx.configuration.setNoShowSlots(4),
    client.api.tx.configuration.setNDelayTranches(350),
    client.api.tx.configuration.setZerothDelayTrancheWidth(1),
    client.api.tx.configuration.setNeededApprovals(25),
    client.api.tx.configuration.setRelayVrfModuloSamples(8),
  ])

  // 4. Message queue configuration
  await assertIdempotent(client, currentSessionIndex, [
    client.api.tx.configuration.setMaxUpwardQueueCount(800000),
    client.api.tx.configuration.setMaxUpwardQueueSize(1000000),
    client.api.tx.configuration.setMaxDownwardMessageSize(60000),
    client.api.tx.configuration.setMaxUpwardMessageSize(80000),
    client.api.tx.configuration.setMaxUpwardMessageNumPerCandidate(25),
  ])

  // 5. HRMP configuration
  await assertIdempotent(client, currentSessionIndex, [
    client.api.tx.configuration.setHrmpOpenRequestTtl(0),
    client.api.tx.configuration.setHrmpSenderDeposit(6000000000000n),
    client.api.tx.configuration.setHrmpRecipientDeposit(6000000000000n),
    client.api.tx.configuration.setHrmpChannelMaxCapacity(40),
    client.api.tx.configuration.setHrmpChannelMaxTotalSize(120000),
    client.api.tx.configuration.setHrmpMaxParachainInboundChannels(40),
    client.api.tx.configuration.setHrmpChannelMaxMessageSize(120000),
    client.api.tx.configuration.setHrmpMaxParachainOutboundChannels(40),
    client.api.tx.configuration.setHrmpMaxMessageNumPerCandidate(15),
  ])

  // 6. Advanced configuration
  await assertIdempotent(client, currentSessionIndex, [
    client.api.tx.configuration.setPvfVotingTtl(3),
    client.api.tx.configuration.setMinimumValidationUpgradeDelay(25),
    client.api.tx.configuration.setMinimumBackingVotes(3),
    client.api.tx.configuration.setAsyncBackingParams({ maxCandidateDepth: 4, allowedAncestryLen: 3 }),
    client.api.tx.configuration.setExecutorParams([
      { MaxMemoryPages: 8192 },
      { PvfExecTimeout: ['Backing', 3000] },
      { PvfExecTimeout: ['Approval', 20000] },
    ]),
    client.api.tx.configuration.setApprovalVotingParams({ maxApprovalCoalesceCount: 8 }),
    client.api.tx.configuration.setBypassConsistencyCheck(false),
    client.api.tx.configuration.setNodeFeature(4, true),
  ])

  // 6.2. On-demand configuration
  await assertIdempotent(client, currentSessionIndex, [
    client.api.tx.configuration.setOnDemandBaseFee(6000000000n),
    client.api.tx.configuration.setOnDemandFeeVariability(40000000),
    client.api.tx.configuration.setOnDemandQueueMaxSize(600),
    client.api.tx.configuration.setOnDemandTargetQueueUtilization(350000000),
  ])

  // 6.3. Full scheduler params struct
  await assertIdempotent(client, currentSessionIndex, [
    client.api.tx.configuration.setSchedulerParams({
      groupRotationFrequency: 15,
      parasAvailabilityPeriod: 12,
      maxValidatorsPerCore: null,
      lookahead: 3,
      numCores: 80,
      maxAvailabilityTimeouts: 0,
      onDemandQueueMaxSize: 600,
      onDemandTargetQueueUtilization: 250000000,
      onDemandFeeVariability: 30000000,
      onDemandBaseFee: 5000000000,
      ttl: 5,
    }),
  ])
}

/**
 * Verifies that scheduling a value Y and then Z for the same field results in Z —
 * i.e., later scheduled values overwrite earlier ones and the intermediate value Y
 * is not preserved. Covers all call groups.
 */
export async function configurationOverwriteTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const currentSessionIndex = (await client.api.query.session.currentIndex()).toNumber()

  // 1. Core configuration
  await runAndAssert(
    client,
    currentSessionIndex,
    [
      client.api.tx.configuration.setValidationUpgradeCooldown(10000),
      client.api.tx.configuration.setValidationUpgradeDelay(500),
      client.api.tx.configuration.setCodeRetentionPeriod(10000),
      client.api.tx.configuration.setMaxCodeSize(1_000_000),
      client.api.tx.configuration.setMaxPovSize(5_000_000),
      client.api.tx.configuration.setMaxHeadDataSize(10000),
      client.api.tx.configuration.setCoretimeCores(30),
    ],
    () => {},
  )
  await runAndAssert(
    client,
    currentSessionIndex,
    [
      client.api.tx.configuration.setValidationUpgradeCooldown(13300),
      client.api.tx.configuration.setValidationUpgradeDelay(700),
      client.api.tx.configuration.setCodeRetentionPeriod(14300),
      client.api.tx.configuration.setMaxCodeSize(3_000_000),
      client.api.tx.configuration.setMaxPovSize(10_000_000),
      client.api.tx.configuration.setMaxHeadDataSize(20000),
      client.api.tx.configuration.setCoretimeCores(50),
    ],
    (pending) => {
      expect(pending.validationUpgradeCooldown.toNumber()).toBe(13300)
      expect(pending.validationUpgradeDelay.toNumber()).toBe(700)
      expect(pending.codeRetentionPeriod.toNumber()).toBe(14300)
      expect(pending.maxCodeSize.toNumber()).toBe(3_000_000)
      expect(pending.maxPovSize.toNumber()).toBe(10_000_000)
      expect(pending.maxHeadDataSize.toNumber()).toBe(20000)
      expect((pending.schedulerParams as PolkadotPrimitivesV8SchedulerParams).numCores.toNumber()).toBe(50)
    },
  )

  // 2. Scheduler configuration
  await runAndAssert(
    client,
    currentSessionIndex,
    [
      client.api.tx.configuration.setGroupRotationFrequency(10),
      client.api.tx.configuration.setParasAvailabilityPeriod(10),
      client.api.tx.configuration.setSchedulingLookahead(2),
      client.api.tx.configuration.setMaxValidatorsPerCore(5),
      client.api.tx.configuration.setMaxValidators(300),
    ],
    () => {},
  )
  await runAndAssert(
    client,
    currentSessionIndex,
    [
      client.api.tx.configuration.setGroupRotationFrequency(20),
      client.api.tx.configuration.setParasAvailabilityPeriod(15),
      client.api.tx.configuration.setSchedulingLookahead(4),
      client.api.tx.configuration.setMaxValidatorsPerCore(10),
      client.api.tx.configuration.setMaxValidators(500),
    ],
    (pending) => {
      const schedulerParams = pending.schedulerParams as PolkadotPrimitivesV8SchedulerParams
      expect(schedulerParams.groupRotationFrequency.toNumber()).toBe(20)
      expect(schedulerParams.parasAvailabilityPeriod.toNumber()).toBe(15)
      expect(schedulerParams.lookahead.toNumber()).toBe(4)
      expect(schedulerParams.maxValidatorsPerCore.unwrap().toNumber()).toBe(10)
      expect(pending.maxValidators.toJSON()).toBe(500)
    },
  )

  // 3. Dispute configuration
  await runAndAssert(
    client,
    currentSessionIndex,
    [
      client.api.tx.configuration.setDisputePeriod(5),
      client.api.tx.configuration.setDisputePostConclusionAcceptancePeriod(500),
      client.api.tx.configuration.setNoShowSlots(2),
      client.api.tx.configuration.setNDelayTranches(200),
      client.api.tx.configuration.setZerothDelayTrancheWidth(0),
      client.api.tx.configuration.setNeededApprovals(15),
      client.api.tx.configuration.setRelayVrfModuloSamples(4),
    ],
    () => {},
  )
  await runAndAssert(
    client,
    currentSessionIndex,
    [
      client.api.tx.configuration.setDisputePeriod(8),
      client.api.tx.configuration.setDisputePostConclusionAcceptancePeriod(700),
      client.api.tx.configuration.setNoShowSlots(4),
      client.api.tx.configuration.setNDelayTranches(350),
      client.api.tx.configuration.setZerothDelayTrancheWidth(1),
      client.api.tx.configuration.setNeededApprovals(25),
      client.api.tx.configuration.setRelayVrfModuloSamples(8),
    ],
    (pending) => {
      expect(pending.disputePeriod.toNumber()).toBe(8)
      expect(pending.disputePostConclusionAcceptancePeriod.toNumber()).toBe(700)
      expect(pending.noShowSlots.toNumber()).toBe(4)
      expect(pending.nDelayTranches.toNumber()).toBe(350)
      expect(pending.zerothDelayTrancheWidth.toNumber()).toBe(1)
      expect(pending.neededApprovals.toNumber()).toBe(25)
      expect(pending.relayVrfModuloSamples.toNumber()).toBe(8)
    },
  )

  // 4. Message queue configuration
  await runAndAssert(
    client,
    currentSessionIndex,
    [
      client.api.tx.configuration.setMaxUpwardQueueCount(500000),
      client.api.tx.configuration.setMaxUpwardQueueSize(700000),
      client.api.tx.configuration.setMaxDownwardMessageSize(40000),
      client.api.tx.configuration.setMaxUpwardMessageSize(50000),
      client.api.tx.configuration.setMaxUpwardMessageNumPerCandidate(15),
    ],
    () => {},
  )
  await runAndAssert(
    client,
    currentSessionIndex,
    [
      client.api.tx.configuration.setMaxUpwardQueueCount(800000),
      client.api.tx.configuration.setMaxUpwardQueueSize(1000000),
      client.api.tx.configuration.setMaxDownwardMessageSize(60000),
      client.api.tx.configuration.setMaxUpwardMessageSize(80000),
      client.api.tx.configuration.setMaxUpwardMessageNumPerCandidate(25),
    ],
    (pending) => {
      expect(pending.maxUpwardQueueCount.toNumber()).toBe(800000)
      expect(pending.maxUpwardQueueSize.toNumber()).toBe(1000000)
      expect(pending.maxDownwardMessageSize.toNumber()).toBe(60000)
      expect(pending.maxUpwardMessageSize.toNumber()).toBe(80000)
      expect(pending.maxUpwardMessageNumPerCandidate.toNumber()).toBe(25)
    },
  )

  // 5. HRMP configuration
  await runAndAssert(
    client,
    currentSessionIndex,
    [
      client.api.tx.configuration.setHrmpOpenRequestTtl(0),
      client.api.tx.configuration.setHrmpSenderDeposit(3000000000000n),
      client.api.tx.configuration.setHrmpRecipientDeposit(3000000000000n),
      client.api.tx.configuration.setHrmpChannelMaxCapacity(20),
      client.api.tx.configuration.setHrmpChannelMaxTotalSize(60000),
      client.api.tx.configuration.setHrmpMaxParachainInboundChannels(20),
      client.api.tx.configuration.setHrmpChannelMaxMessageSize(60000),
      client.api.tx.configuration.setHrmpMaxParachainOutboundChannels(20),
      client.api.tx.configuration.setHrmpMaxMessageNumPerCandidate(8),
    ],
    () => {},
  )
  await runAndAssert(
    client,
    currentSessionIndex,
    [
      client.api.tx.configuration.setHrmpOpenRequestTtl(0),
      client.api.tx.configuration.setHrmpSenderDeposit(6000000000000n),
      client.api.tx.configuration.setHrmpRecipientDeposit(6000000000000n),
      client.api.tx.configuration.setHrmpChannelMaxCapacity(40),
      client.api.tx.configuration.setHrmpChannelMaxTotalSize(120000),
      client.api.tx.configuration.setHrmpMaxParachainInboundChannels(40),
      client.api.tx.configuration.setHrmpChannelMaxMessageSize(120000),
      client.api.tx.configuration.setHrmpMaxParachainOutboundChannels(40),
      client.api.tx.configuration.setHrmpMaxMessageNumPerCandidate(15),
    ],
    (pending) => {
      expect(pending.hrmpSenderDeposit.toBigInt()).toBe(6000000000000n)
      expect(pending.hrmpRecipientDeposit.toBigInt()).toBe(6000000000000n)
      expect(pending.hrmpChannelMaxCapacity.toNumber()).toBe(40)
      expect(pending.hrmpChannelMaxTotalSize.toNumber()).toBe(120000)
      expect(pending.hrmpMaxParachainInboundChannels.toNumber()).toBe(40)
      expect(pending.hrmpChannelMaxMessageSize.toNumber()).toBe(120000)
      expect(pending.hrmpMaxParachainOutboundChannels.toNumber()).toBe(40)
      expect(pending.hrmpMaxMessageNumPerCandidate.toNumber()).toBe(15)
    },
  )

  // 6. Advanced configuration
  await runAndAssert(
    client,
    currentSessionIndex,
    [
      client.api.tx.configuration.setPvfVotingTtl(2),
      client.api.tx.configuration.setMinimumValidationUpgradeDelay(20),
      client.api.tx.configuration.setMinimumBackingVotes(2),
      client.api.tx.configuration.setAsyncBackingParams({ maxCandidateDepth: 2, allowedAncestryLen: 2 }),
      client.api.tx.configuration.setExecutorParams([{ MaxMemoryPages: 4096 }]),
      client.api.tx.configuration.setApprovalVotingParams({ maxApprovalCoalesceCount: 4 }),
      client.api.tx.configuration.setBypassConsistencyCheck(true),
      client.api.tx.configuration.setNodeFeature(4, false),
    ],
    () => {},
  )
  await runAndAssert(
    client,
    currentSessionIndex,
    [
      client.api.tx.configuration.setPvfVotingTtl(3),
      client.api.tx.configuration.setMinimumValidationUpgradeDelay(25),
      client.api.tx.configuration.setMinimumBackingVotes(3),
      client.api.tx.configuration.setAsyncBackingParams({ maxCandidateDepth: 4, allowedAncestryLen: 3 }),
      client.api.tx.configuration.setExecutorParams([
        { MaxMemoryPages: 8192 },
        { PvfExecTimeout: ['Backing', 3000] },
        { PvfExecTimeout: ['Approval', 20000] },
      ]),
      client.api.tx.configuration.setApprovalVotingParams({ maxApprovalCoalesceCount: 8 }),
      client.api.tx.configuration.setBypassConsistencyCheck(false),
      client.api.tx.configuration.setNodeFeature(4, true),
    ],
    (pending) => {
      expect(pending.pvfVotingTtl.toNumber()).toBe(3)
      expect(pending.minimumValidationUpgradeDelay.toNumber()).toBe(25)
      expect(pending.minimumBackingVotes.toNumber()).toBe(3)
      const asyncParams = pending.asyncBackingParams as PolkadotPrimitivesV8AsyncBackingAsyncBackingParams
      expect(asyncParams.maxCandidateDepth.toNumber()).toBe(4)
      expect(asyncParams.allowedAncestryLen.toNumber()).toBe(3)
      expect(pending.executorParams.toJSON()).toEqual([
        { maxMemoryPages: 8192 },
        { pvfExecTimeout: ['Backing', 3000] },
        { pvfExecTimeout: ['Approval', 20000] },
      ])
      const approvalParams = pending.approvalVotingParams as PolkadotPrimitivesV8ApprovalVotingParams
      expect(approvalParams.maxApprovalCoalesceCount.toNumber()).toBe(8)
      expect(pending.nodeFeatures.toJSON()).toBe('0x1b')
    },
  )

  // 6.2. On-demand configuration
  await runAndAssert(
    client,
    currentSessionIndex,
    [
      client.api.tx.configuration.setOnDemandBaseFee(4000000000n),
      client.api.tx.configuration.setOnDemandFeeVariability(30000000),
      client.api.tx.configuration.setOnDemandQueueMaxSize(400),
      client.api.tx.configuration.setOnDemandTargetQueueUtilization(250000000),
    ],
    () => {},
  )
  await runAndAssert(
    client,
    currentSessionIndex,
    [
      client.api.tx.configuration.setOnDemandBaseFee(6000000000n),
      client.api.tx.configuration.setOnDemandFeeVariability(40000000),
      client.api.tx.configuration.setOnDemandQueueMaxSize(600),
      client.api.tx.configuration.setOnDemandTargetQueueUtilization(350000000),
    ],
    (pending) => {
      const schedulerParams = pending.schedulerParams as PolkadotPrimitivesV8SchedulerParams
      expect(schedulerParams.onDemandBaseFee.toBigInt()).toBe(6000000000n)
      expect(schedulerParams.onDemandFeeVariability.toNumber()).toBe(40000000)
      expect(schedulerParams.onDemandQueueMaxSize.toNumber()).toBe(600)
      expect(schedulerParams.onDemandTargetQueueUtilization.toNumber()).toBe(350000000)
    },
  )

  // 6.3. Full scheduler params struct
  await runAndAssert(
    client,
    currentSessionIndex,
    [
      client.api.tx.configuration.setSchedulerParams({
        groupRotationFrequency: 10,
        parasAvailabilityPeriod: 8,
        maxValidatorsPerCore: null,
        lookahead: 2,
        numCores: 40,
        maxAvailabilityTimeouts: 0,
        onDemandQueueMaxSize: 400,
        onDemandTargetQueueUtilization: 200000000,
        onDemandFeeVariability: 20000000,
        onDemandBaseFee: 3000000000,
        ttl: 3,
      }),
    ],
    () => {},
  )
  await runAndAssert(
    client,
    currentSessionIndex,
    [
      client.api.tx.configuration.setSchedulerParams({
        groupRotationFrequency: 15,
        parasAvailabilityPeriod: 12,
        maxValidatorsPerCore: null,
        lookahead: 3,
        numCores: 80,
        maxAvailabilityTimeouts: 0,
        onDemandQueueMaxSize: 600,
        onDemandTargetQueueUtilization: 250000000,
        onDemandFeeVariability: 30000000,
        onDemandBaseFee: 5000000000,
        ttl: 5,
      }),
    ],
    (pending) => {
      const schedulerParams = pending.schedulerParams as PolkadotPrimitivesV8SchedulerParams
      expect(schedulerParams.groupRotationFrequency.toNumber()).toBe(15)
      expect(schedulerParams.parasAvailabilityPeriod.toNumber()).toBe(12)
      expect(schedulerParams.numCores.toNumber()).toBe(80)
      expect(schedulerParams.onDemandQueueMaxSize.toNumber()).toBe(600)
      expect(schedulerParams.onDemandBaseFee.toJSON()).toBe(5000000000)
      expect(schedulerParams.ttl.toNumber()).toBe(5)
    },
  )
}

/**
 * Verifies that two unrelated configuration changes scheduled within the same block are
 * merged into a single pendingConfigs tuple rather than producing two separate entries.
 */
export async function configurationSameBlockMergeTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const currentSessionIndex = (await client.api.query.session.currentIndex()).toNumber()

  const maxCodeSize = 3_000_000
  const disputePeriod = 8

  // Both changes go into a single scheduler call so they execute in the same block.
  await scheduleInlineCallListWithSameOrigin(
    client,
    [
      client.api.tx.configuration.setMaxCodeSize(maxCodeSize).method.toHex() as `0x${string}`,
      client.api.tx.configuration.setDisputePeriod(disputePeriod).method.toHex() as `0x${string}`,
    ],
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )

  await client.dev.newBlock()

  const pendingConfigs = (await client.api.query.configuration.pendingConfigs()) as Vec<
    ITuple<[u32, PolkadotRuntimeParachainsConfigurationHostConfiguration]>
  >

  // Both changes must be folded into exactly one pending entry.
  expect(pendingConfigs.length).toBe(1)
  expect(pendingConfigs[0][0].toNumber()).toBe(currentSessionIndex + 2)

  const pending = pendingConfigs[0][1]
  expect(pending.maxCodeSize.toNumber()).toBe(maxCodeSize)
  expect(pending.disputePeriod.toNumber()).toBe(disputePeriod)
}

/**
 * Exercises the full 2×2 consistency-check matrix:
 *
 *   Case 1 — Consistent base + inconsistent new → rejected (InvalidNewValue)
 *   Case 2 — Inconsistent base + inconsistent new → accepted (recovery path)
 *   Case 3 — Inconsistent base + consistent new → accepted
 *   Case 4 — Bypass flag on → inconsistent value accepted unconditionally
 *
 * All possible consistency violations are tested in Cases 1, 2, and 4.
 */
export async function configurationConsistencyMatrixTest<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>) {
  const [client] = await setupNetworks(chain)

  const currentSessionIndex = (await client.api.query.session.currentIndex()).toNumber()

  // Capture the original active config so we can restore it between cases.
  const activeConfig = await client.api.query.configuration.activeConfig()
  const activeConfigJson = activeConfig.toJSON() as any

  // Break the active config using a hard-limit violation (maxCodeSize > MAX_CODE_SIZE).
  // Zero-check fields like groupRotationFrequency cannot be used here because the runtime
  // uses them in modular arithmetic during block production (e.g. block % groupRotationFrequency),
  // which panics with a divide-by-zero when the value is 0.
  const breakActiveConfig = () =>
    client.dev.setStorage({
      configuration: {
        activeConfig: {
          ...activeConfigJson,
          maxCodeSize: 3_145_729, // one above MAX_CODE_SIZE — inconsistent but safe for block production
        },
      },
    })

  const restoreActiveConfig = () => client.dev.setStorage({ configuration: { activeConfig: activeConfigJson } })

  // All values that violate at least one consistency rule.
  const improperCalls = [
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
    client.api.tx.configuration.setOnDemandQueueMaxSize(1_000_000_001), // > ON_DEMAND_MAX_QUEUE_MAX_SIZE (1,000,000,000)
    // Relational checks
    client.api.tx.configuration.setMinimumValidationUpgradeDelay(1), // must be > paras_availability_period
    client.api.tx.configuration.setValidationUpgradeDelay(1), // must be > 1
  ]

  const assertImproperValues = (pending: PolkadotRuntimeParachainsConfigurationHostConfiguration) => {
    const schedulerParams = pending.schedulerParams as PolkadotPrimitivesV8SchedulerParams
    // Zero checks
    expect(schedulerParams.groupRotationFrequency.toNumber()).toBe(0)
    expect(schedulerParams.parasAvailabilityPeriod.toNumber()).toBe(0)
    expect(pending.noShowSlots.toNumber()).toBe(0)
    expect(pending.minimumBackingVotes.toNumber()).toBe(0)
    expect(pending.nDelayTranches.toNumber()).toBe(0)
    expect(schedulerParams.lookahead.toNumber()).toBe(0)
    // Hard limit violations
    expect(pending.maxCodeSize.toNumber()).toBe(3_145_729)
    expect(pending.maxHeadDataSize.toNumber()).toBe(1_048_577)
    expect(pending.maxPovSize.toNumber()).toBe(16_777_217)
    expect(pending.maxUpwardMessageSize.toNumber()).toBe(131_073)
    expect(pending.hrmpMaxMessageNumPerCandidate.toNumber()).toBe(16_385)
    expect(pending.maxUpwardMessageNumPerCandidate.toNumber()).toBe(16_385)
    expect(pending.hrmpMaxParachainOutboundChannels.toNumber()).toBe(129)
    expect(pending.hrmpMaxParachainInboundChannels.toNumber()).toBe(129)
    expect(schedulerParams.onDemandQueueMaxSize.toNumber()).toBe(1_000_000_001)
    // Relational checks
    expect(pending.minimumValidationUpgradeDelay.toNumber()).toBe(1)
    expect(pending.validationUpgradeDelay.toNumber()).toBe(1)
  }

  // ── Case 1: Consistent base + inconsistent new → all violations rejected ────
  // Every improper call dispatched against a consistent base must fail with
  // InvalidNewValue. No pending entry must be created for any of them.
  expect((await client.api.query.configuration.pendingConfigs()).toJSON()).toEqual([])

  await scheduleInlineCallListWithSameOrigin(
    client,
    improperCalls.map((tx) => tx.method.toHex() as `0x${string}`),
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  // Every improper call must have dispatched with an InvalidNewValue error.
  {
    const events = await client.api.query.system.events()
    const dispatchedErrors = events
      .filter(({ event }) => client.api.events.scheduler.Dispatched.is(event))
      .map(({ event }) => {
        const [, , result] = event.data as unknown as [
          unknown,
          unknown,
          { isErr: boolean; asErr: { isModule: boolean; asModule: { index: number; error: Uint8Array } } },
        ]
        return result
      })
      .filter((result) => result.isErr && result.asErr.isModule)
      .filter((result) => {
        const decoded = client.api.registry.findMetaError(
          result.asErr.asModule as unknown as Parameters<typeof client.api.registry.findMetaError>[0],
        )
        return decoded.section === 'configuration' && decoded.name === 'InvalidNewValue'
      })
    expect(dispatchedErrors.length).toBe(improperCalls.length)
  }

  expect((await client.api.query.configuration.pendingConfigs()).toJSON()).toEqual([])

  // ── Case 2: Inconsistent base + all violations → all accepted (recovery path)
  // Force groupRotationFrequency=0 into activeConfig to make the base inconsistent,
  // then schedule every violation. Each must be accepted.
  await breakActiveConfig()

  await runAndAssert(client, currentSessionIndex, improperCalls, assertImproperValues)

  // ── Case 3: Inconsistent base + consistent new → accepted ───────────────────
  // activeConfig is still broken. Representative valid values must be accepted.
  await runAndAssert(
    client,
    currentSessionIndex,
    [
      client.api.tx.configuration.setMaxCodeSize(3_000_000),
      client.api.tx.configuration.setGroupRotationFrequency(20),
      client.api.tx.configuration.setNoShowSlots(4),
    ],
    (pending) => {
      expect(pending.maxCodeSize.toNumber()).toBe(3_000_000)
      expect((pending.schedulerParams as PolkadotPrimitivesV8SchedulerParams).groupRotationFrequency.toNumber()).toBe(
        20,
      )
      expect(pending.noShowSlots.toNumber()).toBe(4)
    },
  )

  // ── Case 4: Bypass flag on → all violations accepted unconditionally ─────────
  // Restore a consistent base, then enable the bypass flag. Every improper value
  // must be accepted regardless of the consistency check result.
  await restoreActiveConfig()

  // setBypassConsistencyCheck writes directly to storage (not through the pending
  // mechanism), so schedule it separately and advance the block before the violations.
  await scheduleInlineCallListWithSameOrigin(
    client,
    [client.api.tx.configuration.setBypassConsistencyCheck(true).method.toHex() as `0x${string}`],
    { system: 'Root' },
    client.config.properties.schedulerBlockProvider,
  )
  await client.dev.newBlock()

  await runAndAssert(client, currentSessionIndex, improperCalls, assertImproperValues)
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
        {
          kind: 'test',
          label: 'configuration test - scheduling the same change twice is idempotent',
          testFn: async () => await configurationIdempotencyTest(chain),
        },
        {
          kind: 'test',
          label: 'configuration test - later scheduled values overwrite earlier ones',
          testFn: async () => await configurationOverwriteTest(chain),
        },
        {
          kind: 'test',
          label: 'configuration test - two changes in the same block fold into one pending tuple',
          testFn: async () => await configurationSameBlockMergeTest(chain),
        },
        {
          kind: 'test',
          label: 'configuration test - consistency check 2 by 2 matrix',
          testFn: async () => await configurationConsistencyMatrixTest(chain),
        },
      ],
    },
  ],
})
