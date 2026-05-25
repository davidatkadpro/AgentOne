/**
 * Money / quantity bounds shared by invoicing + proposals route schemas.
 *
 * `z.number().nonnegative()` accepts `Infinity` and `1e309 → Infinity` from
 * JSON payloads. That can corrupt invoice totals, PDF rendering, sync
 * payloads, and budget calculations downstream. These helpers enforce
 * `.finite()` and an upper cap to keep stored values inside the range any
 * sane invoice could need.
 *
 * `MONEY_MAX` is in display units (dollars, not cents) since the existing
 * schemas use `unitPrice` as a floating-point dollar amount. A future
 * minor-units migration (tracked separately) would make this cleaner.
 */

import { z } from 'zod'

/** $1B caps a single line item — well above any plausible real invoice. */
export const MONEY_MAX = 1_000_000_000

/** 1M qty units — covers hourly billing at 1 unit/hour for ~114 years. */
export const QTY_MAX = 1_000_000

/** Non-negative finite money amount (USD or other single-currency display unit). */
export const moneyNonNegative = (): z.ZodNumber =>
  z.number().finite().nonnegative().max(MONEY_MAX)

/** Strictly positive finite money (e.g. payment amount). */
export const moneyPositive = (): z.ZodNumber =>
  z.number().finite().positive().max(MONEY_MAX)

/** Non-negative finite quantity. */
export const qtyNonNegative = (): z.ZodNumber =>
  z.number().finite().nonnegative().max(QTY_MAX)
