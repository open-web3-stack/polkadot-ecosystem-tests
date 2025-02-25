import { sendTransaction, withExpect } from '@acala-network/chopsticks-testing'
import { assert, expect } from 'vitest'

import type { StorageValues } from '@acala-network/chopsticks'
import { defaultAccounts } from '@e2e-test/networks'
import type { ApiPromise } from '@polkadot/api'
import type { KeyringPair } from '@polkadot/keyring/types'
import type { PalletStakingValidatorPrefs } from '@polkadot/types/lookup'
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

/**
 * Select some validators from the list present in the `Validators` storage item, in the `Staking` pallet.
 *
 * To avoid fetching all validators at once (over a thousand in Jan. 2025), only the first page of validators
 * in storage is considered - the size of the page is provided as an argument.
 *
 * If, in the validator page of the selected size, less than `validatorCount` validators are available, the function
 * will get as close to `validatorCount` as possible.
 *
 * @param api PJS client object.
 * @param pageSize The size of the page to fetch from storage.
 * @param validatorCount The (desired) number of validators to select.
 * @returns A list of at least 1 validator, and at most 16.
 */
export async function getValidators(api: ApiPromise, pageSize: number, validatorCount: number): Promise<string[]> {
  // Between 1 and 16 validators can be nominated by the pool at any time.
  const min_validators = 1
  const max_validators = 16

  assert(pageSize >= max_validators)
  assert(min_validators <= validatorCount && validatorCount <= max_validators)

  // Query the list of validators from the `Validators` storage item in the `staking` pallet.
  const validators = await api.query.staking.validators.entriesPaged({ args: [], pageSize: pageSize })

  const validatorIds: [string, PalletStakingValidatorPrefs][] = validators.map((tuple) => [
    tuple[0].args[0].toString(),
    tuple[1],
  ])

  const selectedValidators: string[] = []

  let ix = 0
  let count = 0
  while (count < validatorCount) {
    const [valAddr, valData] = validatorIds[ix]

    // The pool's nominator should only select validators who still allow for nominators
    // to select them i.e. they have not blocked themselves.
    if (valData.blocked.isFalse) {
      selectedValidators.push(valAddr)
      count += 1
    }

    ix += 1
  }

  assert(selectedValidators.length >= min_validators && selectedValidators.length <= max_validators)

  return selectedValidators
}

/**
 * Create a given number of keypairs, add some funds to them, and bond those funds.
 */
export async function createAndBondAccounts(
  client: {
    api: ApiPromise
    dev: {
      newBlock: (param?: any) => Promise<string>
      setStorage: (values: StorageValues, blockHash?: string) => Promise<any>
    }
  },
  validatorCount: number,
): Promise<KeyringPair[]> {
  const validators: KeyringPair[] = []

  for (let i = 0; i < validatorCount; i++) {
    const validator = defaultAccounts.keyring.addFromUri(`//Validator_${i}`)
    validators.push(validator)
  }

  await client.dev.setStorage({
    System: {
      account: validators.map((v) => [[v.address], { providers: 1, data: { free: 10000e10 } }]),
    },
  })

  for (let i = 0; i < validatorCount; i++) {
    const bondTx = client.api.tx.staking.bond(1000e10, { Staked: null })
    await sendTransaction(bondTx.signAsync(validators[i]))
  }

  await client.dev.newBlock()

  return validators
}

/**
 * Insert the given validators into storage.
 *
 * The `Validators` storage item is *not* meant to be manipulated directly.
 * However, in the case that the test chain has no validators and it is impracticable to call `validate` and wait
 * for the next era, this function can be used.
 *
 * Note also that normally, a successful call to `validate` would also manipulate the `VoterList` in storage, which is
 * not done here
 * For the purposes of most tests (e.g. just verifying that nominating existing validators works), this can be ignored.
 * @param client
 * @param validators
 */
export async function setValidatorsStorage(
  client: {
    api: ApiPromise
    dev: {
      setStorage: (values: StorageValues, blockHash?: string) => Promise<any>
    }
  },
  validators: string[],
) {
  const minCommission = await client.api.query.staking.minCommission()

  await client.dev.setStorage({
    Staking: {
      Validators: validators.map((val) => [
        [val],
        {
          blocked: false,
          commission: minCommission,
        },
      ]),
    },
  })
}
