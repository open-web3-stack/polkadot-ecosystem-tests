import { withExpect } from '@acala-network/chopsticks-testing'
import { assert, expect } from 'vitest'

import type { StorageValues } from '@acala-network/chopsticks'
import type { ApiPromise } from '@polkadot/api'
import type { HexString } from '@polkadot/util/types'

const { check, checkEvents, checkHrmp, checkSystemEvents, checkUmp } = withExpect((x: any) => ({
  toMatchSnapshot(msg?: string): void {
    expect(x).toMatchSnapshot(msg)
  },
  toMatch(value: any, _msg?: string): void {
    expect(x).toMatch(value)
  },
  toMatchObject(value: any, _msg?: string): void {
    expect(x).toMatchObject(value)
  },
}))

export { check, checkEvents, checkHrmp, checkSystemEvents, checkUmp }

/**
 * Compare the selected properties of two objects.
 *
 * Fails if any of the properties to be compared is different.
 *
 * @param obj1
 * @param obj2
 * @param properties List of properties to be compared
 * @param propertiesToBeSkipped List of properties to not be compared
 * @param msgFun Function that returns a message to be displayed when the comparison fails, based on
 *        the property name - it may capture the objects from the calling function's scope.
 * @param optErrorMsg Optional error message useful when e.g. using this function inside a loop, to
 *        identify failing iteration.
 */
export function objectCmp(
  obj1: object,
  obj2: object,
  properties: string[],
  propertiesToBeSkipped: string[],
  msgFun: (p: string) => string,
  optErrorMsg?: string,
) {
  for (const prop of properties) {
    if (propertiesToBeSkipped.includes(prop)) {
      continue
    }

    const cmp = obj1[prop].eq(obj2[prop])
    if (!cmp) {
      const msg = msgFun(prop)
      let errorMessage: string
      if (optErrorMsg === null || optErrorMsg === undefined) {
        errorMessage = msg
      } else {
        errorMessage = `${optErrorMsg}\n${msg}`
      }
      assert(cmp, errorMessage)
    }
  }
}

/**
 * Given a PJS client and a hex-encoded extrinsic with a given origin, modify the
 * `scheduler` pallet's `agenda` storage to execute the extrinsic in the next block.
 */
export async function scheduleCallWithOrigin(
  client: {
    api: ApiPromise
    dev: {
      setStorage: (values: StorageValues, blockHash?: string) => Promise<any>
    }
  },
  encodedCall: HexString,
  origin: any,
) {
  const number = (await client.api.rpc.chain.getHeader()).number.toNumber()

  await client.dev.setStorage({
    Scheduler: {
      agenda: [
        [
          [number + 1],
          [
            {
              call: {
                Inline: encodedCall,
              },
              origin: origin,
            },
          ],
        ],
      ],
    },
  })
}

/**
 * Send an XCM message containing an extrinsic to be executed in a parachain with a given origin.
 *
 * @param relayClient Relay chain client form which to execute `xcmPallet.send`
 * @param parachainId ID of the parachain to which the XCM message is to be sent
 * @param call Hex-encoded identity pallet extrinsic
 * @param origin Origin with which the extrinsic is to be executed at the location parachain
 * @param requireWeightAtMost Reftime/proof size parameters that `send::Transact` may require (only in XCM v4);
 *        sensible defaults are given.
 */
export async function xcmSendTransact(
  relayClient: {
    api: ApiPromise
    dev: {
      setStorage: (values: StorageValues, blockHash?: string) => Promise<any>
    }
  },
  parachainId: number,
  call: HexString,
  origin: any,
  requireWeightAtMost = { proofSize: '10000', refTime: '100000000' },
): Promise<any> {
  // Destination of the XCM message sent from the relay chain to the parachain via `xcmPallet`
  const dest = {
    V4: {
      parents: 0,
      interior: {
        X1: [
          {
            Parachain: parachainId,
          },
        ],
      },
    },
  }

  // The message being sent to the parachain, containing a call to be executed in the parachain:
  const message = {
    V4: [
      {
        UnpaidExecution: {
          weightLimit: 'Unlimited',
          checkOrigin: null,
        },
      },
      {
        Transact: {
          call: {
            encoded: call,
          },
          originKind: 'SuperUser',
          requireWeightAtMost,
        },
      },
    ],
  }

  const xcmTx = relayClient.api.tx.xcmPallet.send(dest, message)
  const encodedRelayCallData = xcmTx.method.toHex()

  /// See `scheduleCallWithOrigin` for more.

  await scheduleCallWithOrigin(relayClient, encodedRelayCallData, origin)
}
