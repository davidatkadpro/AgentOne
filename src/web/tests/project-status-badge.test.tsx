import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ProjectStatusBadge } from '@/routes/modules/projects/components/ProjectStatusBadge'

describe('ProjectStatusBadge', () => {
  it.each(['pending', 'active', 'blocked', 'completed', 'cancelled'] as const)(
    'renders the %s label',
    (status) => {
      render(<ProjectStatusBadge status={status} />)
      const node = screen.getByTestId(`project-status-${status}`)
      expect(node).toBeInTheDocument()
    },
  )

  it('uses line-through for completed', () => {
    render(<ProjectStatusBadge status="completed" />)
    expect(screen.getByTestId('project-status-completed').className).toContain('line-through')
  })

  it('dims cancelled with opacity', () => {
    render(<ProjectStatusBadge status="cancelled" />)
    expect(screen.getByTestId('project-status-cancelled').className).toMatch(/opacity-60/)
  })

  it('supports a larger size variant', () => {
    render(<ProjectStatusBadge status="active" size="md" />)
    const node = screen.getByTestId('project-status-active')
    expect(node.className).toMatch(/h-6/)
  })
})
