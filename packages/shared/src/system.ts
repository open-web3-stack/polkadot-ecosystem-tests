import { sendTransaction } from '@acala-network/chopsticks-testing'

import { type Chain, type Client, defaultAccountsSr25519 as devAccounts } from '@e2e-test/networks'
import { setupNetworks } from '@e2e-test/shared'

import type { SubmittableExtrinsic } from '@polkadot/api/types'
import type { Null, Result } from '@polkadot/types'
import type { SpRuntimeDispatchError } from '@polkadot/types/lookup'
import { compactAddLength, stringToU8a } from '@polkadot/util'
import type { HexString } from '@polkadot/util/types'

import { assertExpectedEvents, scheduleLookupCallWithOrigin } from './helpers/index.js'
import type { RootTestTree } from './types.js'

type SetCodeFn = (code: Uint8Array | HexString) => SubmittableExtrinsic<'promise'>
type ExpectedEvents = Parameters<typeof assertExpectedEvents>[1]

async function runSetCodeScenario(
  client: Client,
  params: {
    call: SetCodeFn
    expectedAfterSchedule: ExpectedEvents
  },
) {
  const alice = devAccounts.alice

  // fund Alice (preimage for WASM is expensive)
  await client.dev.setStorage({
    System: {
      account: [[[alice.address], { providers: 1, data: { free: 100000 * 1e10 } }]],
    },
  })

  const currentWasm = Buffer.from((await client.chain.head.wasm).slice(2), 'hex')

  const xt = params.call(compactAddLength(currentWasm))
  const call = xt.method

  const preimageTx = client.api.tx.preimage.notePreimage(call.toHex())
  const preimageHash = call.hash
  await sendTransaction(preimageTx.signAsync(alice))
  await client.dev.newBlock({ count: 1 })

  assertExpectedEvents(await client.api.query.system.events(), [
    { type: client.api.events.preimage.Noted, args: { hash_: preimageHash } },
  ])

  await scheduleLookupCallWithOrigin(client, { hash: preimageHash, len: call.encodedLength }, { system: 'Root' })
  await client.dev.newBlock({ count: 1 })

  assertExpectedEvents(await client.api.query.system.events(), params.expectedAfterSchedule)

  // sanity: extrinsic still works after (failed/successful) upgrade attempt
  const remarkContent = stringToU8a('still working')
  const remarkCall = client.api.tx.system.remarkWithEvent(compactAddLength(remarkContent))
  await sendTransaction(remarkCall.signAsync(alice))
  await client.dev.newBlock({ count: 1 })

  assertExpectedEvents(await client.api.query.system.events(), [
    {
      type: client.api.events.system.Remarked,
      args: { hash_: client.api.registry.hash(remarkContent) },
    },
  ])
}

export async function setCodeTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>) {
  const [client] = await setupNetworks(chain)
  return runSetCodeScenario(client, {
    call: client.api.tx.system.setCode,
    expectedAfterSchedule: [
      {
        type: client.api.events.scheduler.Dispatched,
        args: { result: (r: Result<Null, SpRuntimeDispatchError>) => r.isErr }, // expected failure
      },
    ],
  })
}

export async function setCodeWithoutChecksTests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStoragesRelay extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStoragesRelay>) {
  const [client] = await setupNetworks(chain)
  return runSetCodeScenario(client, {
    call: client.api.tx.system.setCodeWithoutChecks,
    expectedAfterSchedule: [
      {
        type: client.api.events.scheduler.Dispatched,
        args: { result: (r: Result<Null, SpRuntimeDispatchError>) => r.isOk }, // expected success
      },
      { type: client.api.events.system.CodeUpdated },
    ],
  })
}

export function systemE2ETests<
  TCustom extends Record<string, unknown> | undefined,
  TInitStorages extends Record<string, Record<string, any>> | undefined,
>(chain: Chain<TCustom, TInitStorages>, testConfig: { testSuiteName: string; addressEncoding: number }): RootTestTree {
  return {
    kind: 'describe',
    label: testConfig.testSuiteName,
    children: [
      {
        kind: 'test',
        label: 'set_code doesnt allow upgrade to the same wasm',
        testFn: async () => await setCodeTests(chain),
      },
      {
        kind: 'test',
        label: 'set_code_without_checks allows upgrade to the same wasm',
        testFn: async () => await setCodeWithoutChecksTests(chain),
      },
    ],
  }
}
