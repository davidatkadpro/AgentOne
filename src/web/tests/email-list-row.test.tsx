import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EmailListRow } from '@/routes/modules/email/components/EmailListRow'
import type { Email } from '@/types/domain'

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: 'e1',
    sourceKind: 'maildir',
    sourceId: 'msg-1',
    receivedAt: Date.now() - 60_000,
    fromAddress: 'someone@example.com',
    fromName: 'Someone',
    subject: 'RFI: fixtures',
    snippet: 'A short preview',
    hasAttachments: false,
    isRead: false,
    filedProjectId: null,
    filedFolderPath: null,
    filedAt: null,
    metadata: {},
    createdAt: Date.now() - 60_000,
    ...overrides,
  }
}

describe('EmailListRow', () => {
  it('renders sender, subject, snippet', () => {
    render(
      <EmailListRow email={makeEmail()} isActive={false} chip={null} onClick={() => {}} />,
    )
    expect(screen.getByText('Someone')).toBeInTheDocument()
    expect(screen.getByText('RFI: fixtures')).toBeInTheDocument()
    expect(screen.getByText('A short preview')).toBeInTheDocument()
  })

  it('falls back to from-address when no name', () => {
    render(
      <EmailListRow
        email={makeEmail({ fromName: null })}
        isActive={false}
        chip={null}
        onClick={() => {}}
      />,
    )
    expect(screen.getByText('someone@example.com')).toBeInTheDocument()
  })

  it('shows the paperclip icon when hasAttachments', () => {
    const { container } = render(
      <EmailListRow
        email={makeEmail({ hasAttachments: true })}
        isActive={false}
        chip={null}
        onClick={() => {}}
      />,
    )
    // lucide icons render as svg; presence is enough.
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('shows the "filed" chip when the email is filed', () => {
    render(
      <EmailListRow
        email={makeEmail({ filedProjectId: 'p-1' })}
        isActive={false}
        chip={null}
        onClick={() => {}}
      />,
    )
    expect(screen.getByText('filed')).toBeInTheDocument()
  })

  it('calls onClick when the row is clicked', () => {
    const onClick = vi.fn()
    render(<EmailListRow email={makeEmail()} isActive={false} chip={null} onClick={onClick} />)
    fireEvent.click(screen.getByTestId('email-row-e1'))
    expect(onClick).toHaveBeenCalled()
  })

  it('applies the active treatment when isActive is true', () => {
    const { container } = render(
      <EmailListRow email={makeEmail()} isActive={true} chip={null} onClick={() => {}} />,
    )
    expect(container.querySelector('.bg-accent\\/10')).toBeInTheDocument()
  })
})
