import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ConnectionBanner } from '@/routes/modules/invoicing/components/ConnectionBanner'
import { TestRouter } from './helpers/test-router'

function withRouter(node: React.ReactNode) {
  return <TestRouter>{node}</TestRouter>
}

describe('ConnectionBanner', () => {
  it('renders when disconnected', () => {
    render(withRouter(<ConnectionBanner qbo={{ connected: false }} />))
    expect(screen.getByTestId('connection-banner')).toBeInTheDocument()
    expect(screen.getByTestId('connection-banner-reconnect')).toHaveAttribute(
      'href',
      '/settings?tab=integrations',
    )
  })

  it('renders when connected but token has expired', () => {
    render(
      withRouter(
        <ConnectionBanner
          qbo={{
            connected: true,
            realmId: 'r1',
            tokenExpiresAt: Date.now() - 1000,
          }}
        />,
      ),
    )
    expect(screen.getByTestId('connection-banner')).toBeInTheDocument()
    expect(screen.getByText(/expired/i)).toBeInTheDocument()
  })

  it('hides when connected and not expired', () => {
    const { container } = render(
      withRouter(
        <ConnectionBanner
          qbo={{
            connected: true,
            realmId: 'r1',
            tokenExpiresAt: Date.now() + 60_000,
          }}
        />,
      ),
    )
    expect(container.querySelector('[data-testid="connection-banner"]')).toBeNull()
  })
})
