import type { Chain } from '@e2e-test/networks'

import { u8aToHex } from '@polkadot/util'

import { assert, describe, expect, it } from 'vitest'

import { setupNetworks } from './setup.js'

const TIMESLICE_PERIOD = 80
const PARTS_OF_57600 = 57_600
const PARTS_PER_MASK_BIT = PARTS_OF_57600 / 80
const MAX_RELAY_ASSIGNMENTS = 28
const RELAY_TASK_LIMIT = 27

/**
 * Builds a one-bit `CoreMask` for a broker workplan item.
 */
function singleBitCoreMask(index: number): `0x${string}` {
  const mask = new Uint8Array(10)
  mask[Math.floor(index / 8)] |= 0x80 >> (index % 8)
  return u8aToHex(mask) as `0x${string}`
}

/**
 * Normalizes assignment tuples from PJS JSON into stable string/value pairs.
 */
function normalizeAssignments(raw: [any, number][]): [string, number][] {
  return raw.map(([assignment, parts]) => {
    if (assignment === 'Idle' || (typeof assignment === 'object' && assignment !== null && 'idle' in assignment)) {
      return ['Idle', parts]
    }

    if (assignment === 'Pool' || (typeof assignment === 'object' && assignment !== null && 'pool' in assignment)) {
      return ['Pool', parts]
    }

    const task = assignment.task ?? assignment.Task
    return [`Task(${task})`, parts]
  })
}

/**
 * Builds the truncated assignment vector the relay should receive.
 */
function expectedRelayAssignments(firstTask: number): [string, number][] {
  return [
    ['Idle', PARTS_OF_57600 - RELAY_TASK_LIMIT * PARTS_PER_MASK_BIT],
    ...Array.from(
      { length: RELAY_TASK_LIMIT },
      (_, index) => [`Task(${firstTask + index})`, PARTS_PER_MASK_BIT] as [string, number],
    ),
  ]
}

/**
 * Coretime-to-relay assignment verification scenario
 *
 * To be used by coretime chains to verify that broker assignments are truncated as expected,
 * sent to the relay in `assignCore`, and written to `paraScheduler.CoreSchedules`
 *
 * 1. Rewinds broker state by one committed timeslice and injects an 80-item workplan.
 * 2. Builds one coretime block and decodes the emitted UMP `assignCore` call.
 * 3. Verifies that the relay-bound assignment vector was truncated to `Idle` + 27 tasks.
 * 4. Builds one relay block and verifies the same truncated assignments were stored in
 *    `paraScheduler.CoreSchedules`.
 */
export function coretimeAssignCoreE2ETests<
  TCustomRelay extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
  TCustomCoretime extends Record<string, unknown> | undefined,
  TInitStoragesCoretime extends Record<string, Record<string, any>> | undefined,
>(
  relayChain: Chain<TCustomRelay, TInitStoragesRelay>,
  coretimeChain: Chain<TCustomCoretime, TInitStoragesCoretime>,
  testConfig: { testSuiteName: string },
) {
  describe(testConfig.testSuiteName, async () => {
    const [relayClient, coretimeClient] = await setupNetworks(relayChain, coretimeChain)

    it('sends the truncated coretime assignment to the relay and stores it there', async () => {
      const firstTask = 2000
      const fullWorkplanLength = 80

      // Rewind the broker by one committed timeslice so the injected workplan gets processed on
      // the very next coretime block.
      const status = ((await coretimeClient.api.query.broker.status()) as any).unwrap()
      const testCore = status.coreCount.toNumber() - 1
      const commitTimeslice = status.lastCommittedTimeslice.toNumber()
      const expectedAssignments = expectedRelayAssignments(firstTask)

      // One task per mask bit gives the broker an 80-entry schedule, which is larger than what
      // the relay currently accepts in a single `assignCore` call.
      const workplanItems = Array.from({ length: fullWorkplanLength }, (_, index) => ({
        mask: singleBitCoreMask(index),
        assignment: { Task: firstTask + index },
      }))

      await coretimeClient.dev.setStorage({
        Broker: {
          status: {
            ...(status.toJSON() as Record<string, unknown>),
            lastCommittedTimeslice: commitTimeslice - 1,
          },
          workplan: [[[[commitTimeslice, testCore]], workplanItems]],
        },
      })

      await coretimeClient.dev.newBlock()

      const brokerEvents = await coretimeClient.api.query.system.events()
      assert(
        brokerEvents.some(({ event }) => event.section === 'broker' && event.method === 'CoreAssigned'),
        'broker never emitted `CoreAssigned`',
      )

      // Decode the upward message with the relay registry, since the embedded `Transact.call`
      // is a relay-chain extrinsic.
      const umpMessages = coretimeClient.api
        .createType('Vec<XcmVersionedXcm>', await coretimeClient.api.query.parachainSystem.upwardMessages())
        .toJSON() as any[]

      let encodedTransactCall: `0x${string}` | undefined
      for (const versionedXcm of umpMessages) {
        for (const value of Object.values(versionedXcm) as any[]) {
          if (!Array.isArray(value)) {
            continue
          }

          for (const instruction of value) {
            if (instruction.transact === undefined) {
              continue
            }

            const candidate = relayClient.api.registry.createType('Call', instruction.transact.call.encoded)
            if (candidate.section === 'coretime' && candidate.method === 'assignCore') {
              encodedTransactCall = instruction.transact.call.encoded
            }
          }
        }
      }

      assert(encodedTransactCall, 'no `coretime.assignCore` transact found in UMP messages')

      const assignCoreCall = relayClient.api.registry.createType('Call', encodedTransactCall)
      const [callCore, callBegin, callAssignment, callEndHint] = assignCoreCall.args
      const sentAssignments = normalizeAssignments(callAssignment.toJSON() as [any, number][])

      expect(callCore.toJSON()).toBe(testCore)
      expect(callBegin.toJSON()).toBe(commitTimeslice * TIMESLICE_PERIOD)
      expect(callEndHint.toJSON()).toBeNull()
      expect(sentAssignments).toHaveLength(MAX_RELAY_ASSIGNMENTS)
      expect(sentAssignments).toEqual(expectedAssignments)

      // Process the UMP on the relay, then check both dispatch success and the scheduler state.
      await relayClient.dev.newBlock()

      const relayEvents = await relayClient.api.query.system.events()
      const processedEvents = relayEvents.filter(
        ({ event }) => event.section === 'messageQueue' && event.method === 'Processed',
      )

      assert(processedEvents.length > 0, 'relay chain processed no messages')
      for (const { event } of processedEvents) {
        expect((event.data as any).success.isTrue, '`coretime.assignCore` UMP failed to dispatch').toBe(true)
      }

      const coreAssignedOnRelay = relayEvents.find(
        ({ event }) => event.section === 'coretime' && event.method === 'CoreAssigned',
      )

      assert(coreAssignedOnRelay, 'relay chain never emitted `coretime.CoreAssigned`')
      expect((coreAssignedOnRelay.event.data as any).core.toNumber()).toBe(testCore)

      const coreSchedules = await relayClient.api.query.paraScheduler.coreSchedules.entries()
      const testCoreSchedules = coreSchedules
        .map(([key, schedule]) => {
          const [begin, core] = key.args[0] as unknown as [any, any]
          return { begin: begin.toNumber(), core: core.toNumber(), schedule: (schedule as any).unwrap().toJSON() }
        })
        .filter(({ core }) => core === testCore)

      assert(testCoreSchedules.length > 0, `no \`CoreSchedules\` entry found for core ${testCore}`)

      // The relay may append to an existing queue for this core, so match our truncated vector as
      // the tail of a schedule instead of assuming a fresh entry.
      const storedTruncatedTail = testCoreSchedules
        .map(({ schedule }) => normalizeAssignments(schedule.assignments as [any, number][]))
        .map((assignments) => assignments.slice(-MAX_RELAY_ASSIGNMENTS))
        .find((tail) => JSON.stringify(tail) === JSON.stringify(expectedAssignments))

      assert(
        storedTruncatedTail,
        `relay \`CoreSchedules\` for core ${testCore} does not contain the truncated assignments; found: ${JSON.stringify(testCoreSchedules)}`,
      )

      // The proof of truncation is that the dropped tasks never appear in any stored schedule for
      // this core.
      const allStoredTasks = testCoreSchedules.flatMap(({ schedule }) =>
        normalizeAssignments(schedule.assignments as [any, number][]).map(([kind]) => kind),
      )

      for (let index = RELAY_TASK_LIMIT; index < fullWorkplanLength; index++) {
        expect(allStoredTasks).not.toContain(`Task(${firstTask + index})`)
      }
    })
  })
}
