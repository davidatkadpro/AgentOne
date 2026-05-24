import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { SlashOverlay } from '@/routes/chat/SlashOverlay'

// Stub the useCommands hook so we can drive the visible list without
// mocking the global fetch.
vi.mock('@/api/commands', () => ({
  useCommands: () => ({
    data: [
      { name: 'help', description: 'Show help', source: 'system' },
      { name: 'invoke', description: 'Run an action', source: 'system' },
      { name: 'invoice', description: 'Open invoice', source: 'skill' },
      { name: 'distill', description: 'Distill session notes', source: 'system' },
    ],
    isLoading: false,
  }),
}))

function withQuery(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>
}

beforeEach(() => {
  // Nothing to reset — the mock is module-scoped.
})

describe('SlashOverlay filter', () => {
  it('renders every command when query is empty', () => {
    render(
      withQuery(
        <SlashOverlay open query="" onSelectCommand={() => {}} onClose={() => {}} />,
      ),
    )
    const rows = screen.getAllByTestId('slash-overlay-row')
    expect(rows.length).toBe(4)
  })

  it('filters by prefix match on the command name', () => {
    render(
      withQuery(
        <SlashOverlay open query="inv" onSelectCommand={() => {}} onClose={() => {}} />,
      ),
    )
    const rows = screen.getAllByTestId('slash-overlay-row')
    // `invoke` and `invoice` both match.
    expect(rows.length).toBe(2)
    expect(rows[0]?.textContent).toContain('invoke')
    expect(rows[1]?.textContent).toContain('invoice')
  })

  it('falls back to description substring match', () => {
    render(
      withQuery(
        <SlashOverlay
          open
          query="session"
          onSelectCommand={() => {}}
          onClose={() => {}}
        />,
      ),
    )
    const rows = screen.getAllByTestId('slash-overlay-row')
    // Only `distill` has "session" in its description.
    expect(rows.length).toBe(1)
    expect(rows[0]?.textContent).toContain('distill')
  })

  it('shows the no-match copy when nothing matches', () => {
    render(
      withQuery(
        <SlashOverlay
          open
          query="zzzzzzzz"
          onSelectCommand={() => {}}
          onClose={() => {}}
        />,
      ),
    )
    expect(screen.queryAllByTestId('slash-overlay-row').length).toBe(0)
    expect(screen.getByTestId('slash-overlay')).toHaveTextContent(/No commands match/i)
  })

  it('returns null when closed', () => {
    const { container } = render(
      withQuery(
        <SlashOverlay
          open={false}
          query="inv"
          onSelectCommand={() => {}}
          onClose={() => {}}
        />,
      ),
    )
    expect(container.querySelector('[data-testid="slash-overlay"]')).toBeNull()
  })
})
