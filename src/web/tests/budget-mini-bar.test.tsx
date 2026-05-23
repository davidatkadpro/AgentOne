import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BudgetMiniBar } from '@/routes/modules/projects/components/BudgetMiniBar'

describe('BudgetMiniBar', () => {
  it('hides when budgetCents is null', () => {
    const { container } = render(<BudgetMiniBar invoicedCents={0} budgetCents={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('hides when budgetCents is zero', () => {
    const { container } = render(<BudgetMiniBar invoicedCents={0} budgetCents={0} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows rounded percentage for normal range', () => {
    render(<BudgetMiniBar invoicedCents={5000} budgetCents={10000} />)
    expect(screen.getByText('50%')).toBeInTheDocument()
  })

  it('applies warn tone when above 90%', () => {
    const { container } = render(
      <BudgetMiniBar invoicedCents={9500} budgetCents={10000} />,
    )
    expect(container.querySelector('.bg-warn')).toBeInTheDocument()
  })

  it('applies danger tone when above 100%', () => {
    const { container } = render(
      <BudgetMiniBar invoicedCents={12000} budgetCents={10000} />,
    )
    expect(container.querySelector('.bg-danger')).toBeInTheDocument()
  })
})
