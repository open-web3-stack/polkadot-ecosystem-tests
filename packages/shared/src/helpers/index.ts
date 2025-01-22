import { assert, expect } from 'vitest'
import { withExpect } from '@acala-network/chopsticks-testing'

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
  optErrorMsg?: string
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
        errorMessage = optErrorMsg + '\n' + msg
      }
      assert(cmp, errorMessage)
    }
  }
}