import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { M365StatusResponse } from '@/types/api'
import { M365IntegrationPanel } from '@/routes/settings/M365IntegrationPanel'
import { TestRouter } from './helpers/test-router'

const mockGet = vi.fn()
const mockPost = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
  ApiError: class extends Error {},
}))

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))

function renderPanel(status: M365StatusResponse, initialEntries = ['/settings?tab=integrations']) {
  mockGet.mockResolvedValue(status)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TestRouter initialEntries={initialEntries}>
        <M365IntegrationPanel />
      </TestRouter>
    </QueryClientProvider>,
  )
}

describe('M365IntegrationPanel', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPost.mockReset()
    toastSuccess.mockReset()
    toastError.mockReset()
  })

  it('renders the Connect link when disconnected', async () => {
    renderPanel({ connected: false })
    const connect = await waitFor(() => screen.getByTestId('m365-connect'))
    expect(connect).toHaveAttribute('href', '/api/integrations/m365/connect')
    expect(screen.getByText('Not connected')).toBeInTheDocument()
    expect(screen.queryByTestId('m365-disconnect')).toBeNull()
  })

  it('renders account details + Disconnect when connected', async () => {
    renderPanel({
      connected: true,
      accountName: 'Knowles Studio',
      accountEmail: 'studio@knowles.example',
      connectedAt: Date.now() - 60_000,
      tokenExpiresAt: Date.now() + 3_600_000,
      lastPollAt: Date.now() - 5_000,
      lastError: null,
    })
    await waitFor(() => screen.getByTestId('m365-details'))
    expect(screen.getByText(/studio@knowles\.example/)).toBeInTheDocument()
    expect(screen.getByText(/Account · Knowles Studio/)).toBeInTheDocument()
    expect(screen.getByTestId('m365-disconnect')).toBeInTheDocument()
    expect(screen.queryByTestId('m365-connect')).toBeNull()
  })

  it('surfaces lastError when present', async () => {
    renderPanel({
      connected: true,
      accountEmail: 'studio@knowles.example',
      lastError: { code: 'GRAPH_ERROR', message: 'rate limited', at: Date.now() },
    })
    await waitFor(() => screen.getByTestId('m365-details'))
    expect(screen.getByText(/Last error · rate limited/)).toBeInTheDocument()
  })

  it('confirms then calls the disconnect endpoint', async () => {
    mockPost.mockResolvedValue({ ok: true })
    renderPanel({ connected: true, accountEmail: 'studio@knowles.example' })
    const btn = await waitFor(() => screen.getByTestId('m365-disconnect'))
    fireEvent.click(btn)
    const confirm = await waitFor(() => screen.getByTestId('m365-disconnect-confirm'))
    fireEvent.click(confirm)
    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith('/integrations/m365/disconnect', {})
    })
  })

  it('toasts success when returning from a connected redirect', async () => {
    renderPanel({ connected: true, accountEmail: 'studio@knowles.example' }, [
      '/settings?tab=integrations&m365=connected',
    ])
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Microsoft 365 connected'))
  })

  it('toasts the reason when returning from an error redirect', async () => {
    renderPanel({ connected: false }, ['/settings?tab=integrations&m365=error&reason=bad_state'])
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringContaining('bad_state')),
    )
  })
})
