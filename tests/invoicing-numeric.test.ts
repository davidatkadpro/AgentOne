import { describe, expect, it } from 'vitest'
import {
  MONEY_MAX,
  QTY_MAX,
  moneyNonNegative,
  moneyPositive,
  qtyNonNegative,
} from '../src/modules/numeric.js'

describe('numeric bounds — money/qty schemas', () => {
  const money = moneyNonNegative()
  const moneyPos = moneyPositive()
  const qty = qtyNonNegative()

  it('rejects Infinity (the historical 1e309 path)', () => {
    // JSON.parse('1e309') = Infinity in Node.
    expect(JSON.parse('1e309')).toBe(Infinity)
    expect(money.safeParse(Infinity).success).toBe(false)
    expect(moneyPos.safeParse(Infinity).success).toBe(false)
    expect(qty.safeParse(Infinity).success).toBe(false)
  })

  it('rejects -Infinity', () => {
    expect(money.safeParse(-Infinity).success).toBe(false)
  })

  it('rejects NaN', () => {
    expect(money.safeParse(NaN).success).toBe(false)
    expect(moneyPos.safeParse(NaN).success).toBe(false)
    expect(qty.safeParse(NaN).success).toBe(false)
  })

  it('rejects values above MONEY_MAX', () => {
    expect(money.safeParse(MONEY_MAX + 1).success).toBe(false)
    expect(money.safeParse(MONEY_MAX).success).toBe(true)
    expect(money.safeParse(MONEY_MAX - 1).success).toBe(true)
  })

  it('rejects qty above QTY_MAX', () => {
    expect(qty.safeParse(QTY_MAX + 1).success).toBe(false)
    expect(qty.safeParse(QTY_MAX).success).toBe(true)
  })

  it('accepts zero for nonnegative money but rejects for positive money', () => {
    expect(money.safeParse(0).success).toBe(true)
    expect(moneyPos.safeParse(0).success).toBe(false)
  })

  it('accepts fractional quantities', () => {
    expect(qty.safeParse(2.5).success).toBe(true)
    expect(qty.safeParse(0.125).success).toBe(true)
  })

  it('rejects negative inputs', () => {
    expect(money.safeParse(-1).success).toBe(false)
    expect(moneyPos.safeParse(-0.01).success).toBe(false)
    expect(qty.safeParse(-0.5).success).toBe(false)
  })
})
