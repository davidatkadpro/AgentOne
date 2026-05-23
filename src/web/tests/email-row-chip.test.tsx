import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EmailRowChip } from '@/routes/modules/email/components/EmailRowChip'
import type { EmailActionChip } from '@/types/domain'

const baseChip: EmailActionChip = {
  emailId: 'e1',
  action: 'file-to-project',
  sessionId: 's1',
  status: 'running',
  startedAt: 1,
}

describe('EmailRowChip', () => {
  it('renders nothing when chip is null', () => {
    const { container } = render(<EmailRowChip chip={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the running variant with the action name', () => {
    render(<EmailRowChip chip={baseChip} />)
    expect(screen.getByTestId('email-chip-running')).toBeInTheDocument()
    expect(screen.getByText(/file-to-project/i)).toBeInTheDocument()
  })

  it('renders the completed variant', () => {
    render(
      <EmailRowChip
        chip={{
          ...baseChip,
          status: 'completed',
          result: { projectId: 'p-1' },
        }}
      />,
    )
    expect(screen.getByTestId('email-chip-completed')).toBeInTheDocument()
    expect(screen.getByText('filed')).toBeInTheDocument()
  })

  it('renders the failed variant', () => {
    render(<EmailRowChip chip={{ ...baseChip, status: 'failed' }} />)
    expect(screen.getByTestId('email-chip-failed')).toBeInTheDocument()
  })

  it('navigates to the project on click when chip is completed with a projectId', () => {
    const onNavigateProject = vi.fn()
    render(
      <EmailRowChip
        chip={{ ...baseChip, status: 'completed', result: { projectId: 'p-9' } }}
        onNavigateProject={onNavigateProject}
      />,
    )
    fireEvent.click(screen.getByTestId('email-chip-completed'))
    expect(onNavigateProject).toHaveBeenCalledWith('p-9')
  })

  it('does not navigate while running', () => {
    const onNavigateProject = vi.fn()
    const { container } = render(
      <EmailRowChip chip={baseChip} onNavigateProject={onNavigateProject} />,
    )
    // Running chips render as <span>, not <button>, so they have no role=button.
    expect(container.querySelector('button')).toBeNull()
  })
})
