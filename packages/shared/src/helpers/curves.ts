import type { PalletReferendaCurve } from '@polkadot/types/lookup'

import { match } from 'ts-pattern'

/**
 * `pallet_referenda` approval/support curve math (`Curve::threshold`/`Curve::delay` from
 * `substrate/frame/referenda/src/types.rs`), reimplemented in `bigint` arithmetic so tests can
 * compute - instead of waiting out - the tally a referendum needs to pass at a given point in its
 * decision/confirmation period.
 *
 * All rounding here is bit-exact with the runtime: `Perbill` division/multiplication both
 * truncate (`Rounding::Down`), and `FixedI64::checked_rounding_div` truncates towards negative
 * infinity for `threshold` (`Low`) and towards positive infinity for `delay` (`High`). Every
 * curve field (`length`/`floor`/`ceil`/`begin`/`end`/`step`/`period` as `Perbill`,
 * `factor`/`xOffset`/`yOffset` as `FixedI64`) already shares the same parts-per-billion
 * fixed-point scale on-chain, so they can be read via `.toBigInt()` and mixed freely below.
 */

/** Denominator of the parts-per-billion fixed-point scale shared by `Perbill` and `FixedI64`. */
export const PERBILL_ONE = 1_000_000_000n

/** `bigint` floor division (rounds towards negative infinity, unlike `/`'s truncation towards zero). */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b
  const r = a % b
  return r !== 0n && r < 0n !== b < 0n ? q - 1n : q
}

/** `bigint` ceiling division (rounds towards positive infinity). */
function ceilDiv(a: bigint, b: bigint): bigint {
  return -floorDiv(-a, b)
}

/** Clamp a value into a valid `Perbill` range (`Perthing::try_into_perthing`'s failure case saturates to `one`). */
function clampPerbill(x: bigint): bigint {
  if (x < 0n) return 0n
  if (x > PERBILL_ONE) return PERBILL_ONE
  return x
}

/**
 * Convert a `elapsed`/`period` block count pair into the `Perbill` fraction `pallet_referenda`
 * uses as curves' `x` input: `Perbill::from_rational(elapsed.min(period), period)`.
 */
export function elapsedToPerbill(elapsed: bigint, period: bigint): bigint {
  if (period <= 0n) return PERBILL_ONE
  const clamped = elapsed < period ? elapsed : period
  return floorDiv(clamped * PERBILL_ONE, period)
}

/**
 * Evaluate a curve's minimum-passing threshold at `x` (parts-per-billion elapsed fraction of the
 * decision period). Mirrors `Curve::threshold`.
 */
export function curveThreshold(curve: PalletReferendaCurve, x: bigint): bigint {
  return match(curve.type)
    .with('LinearDecreasing', (): bigint => {
      const { length, floor, ceil } = curve.asLinearDecreasing
      const lengthB = length.toBigInt()
      const floorB = floor.toBigInt()
      const ceilB = ceil.toBigInt()
      // `x.min(length).saturating_div(length, Down)` saturates to `one` when `length == 0`,
      // which makes the subsequent subtraction collapse to `floor` regardless.
      if (lengthB === 0n) return floorB
      const xClamped = x < lengthB ? x : lengthB
      const ratio = floorDiv(xClamped * PERBILL_ONE, lengthB)
      const drop = floorDiv(ratio * (ceilB - floorB), PERBILL_ONE)
      return ceilB - drop
    })
    .with('Reciprocal', (): bigint => {
      const { factor, xOffset, yOffset } = curve.asReciprocal
      const factorB = factor.toBigInt()
      const xOffsetB = xOffset.toBigInt()
      const yOffsetB = yOffset.toBigInt()
      const denom = x + xOffsetB
      // `checked_rounding_div` returns `None` (-> `Perbill::one()`) for a non-positive divisor.
      if (denom <= 0n) return PERBILL_ONE
      const term = floorDiv(factorB * PERBILL_ONE, denom)
      return clampPerbill(term + yOffsetB)
    })
    .otherwise((unhandledCurveType) => {
      throw new Error(`Unhandled curve type: ${unhandledCurveType}`)
    })
}

export interface PassingTally {
  ayes: bigint
  nays: bigint
  support: bigint
}

/**
 * Compute a conviction-voting tally that clears both a track's `minApproval` and `minSupport`
 * curves at `elapsedPerbill` (parts-per-billion of the decision period elapsed since
 * `deciding.since`).
 *
 * The tally is aye-only (`nays = 0`): with no nay votes, `approval = ayes / (ayes + nays)` is
 * always `100%`, which trivially clears any approval curve (approval curves never require more
 * than `100%`). That leaves the support curve (`support / totalIssuance`) as the only real
 * constraint, so `ayes` is set equal to the smallest `support` that clears it, rounded up so the
 * resulting balance's share of `totalIssuance` is guaranteed to be `>=` the threshold.
 *
 * `marginPerbill` pads the computed support threshold before converting it to a balance, to
 * absorb any drift between the `elapsedPerbill` assumed here and the block at which the runtime
 * actually evaluates the referendum.
 */
export function computeMinimumPassingTally(
  track: { minApproval: PalletReferendaCurve; minSupport: PalletReferendaCurve },
  elapsedPerbill: bigint,
  totalIssuance: bigint,
  marginPerbill: bigint = PERBILL_ONE / 1000n,
): PassingTally {
  const supportThreshold = curveThreshold(track.minSupport, elapsedPerbill)
  const paddedSupport = clampPerbill(supportThreshold + marginPerbill)
  const support = ceilDiv(paddedSupport * totalIssuance, PERBILL_ONE)

  return { ayes: support, nays: 0n, support }
}
