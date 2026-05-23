import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { EmailBody } from '@/routes/modules/email/components/EmailBody'

const mockGet = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockGet(...args),
  },
  ApiError: class extends Error {},
}))

function renderWithClient(emailId: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <EmailBody emailId={emailId} />
    </QueryClientProvider>,
  )
}

describe('EmailBody', () => {
  beforeEach(() => {
    mockGet.mockReset()
  })

  it('renders plain text bodies verbatim', async () => {
    mockGet.mockResolvedValue({
      emailId: 'e1',
      kind: 'text',
      content: 'Hello\nworld',
      attachments: [],
    })
    renderWithClient('e1')
    await waitFor(() => {
      expect(screen.getByTestId('email-body-text')).toBeInTheDocument()
    })
    expect(screen.getByTestId('email-body-text')).toHaveTextContent('Hello world')
  })

  it('strips script tags from HTML bodies even if the server sanitiser missed them', async () => {
    // The server sanitiser is the primary defence. This test simulates a
    // hypothetical regression by feeding the component a poisoned payload —
    // DOMPurify should still scrub it.
    mockGet.mockResolvedValue({
      emailId: 'e2',
      kind: 'html',
      content: '<p>safe</p><script>alert(1)</script>',
      attachments: [],
    })
    renderWithClient('e2')
    const html = await waitFor(() => screen.getByTestId('email-body-html'))
    expect(html.innerHTML).toContain('<p>safe</p>')
    expect(html.innerHTML).not.toContain('script')
  })

  it('strips on* event handlers + style attributes', async () => {
    mockGet.mockResolvedValue({
      emailId: 'e3',
      kind: 'html',
      content: '<a href="https://x.com" onclick="evil()" style="color:red">link</a>',
      attachments: [],
    })
    renderWithClient('e3')
    const html = await waitFor(() => screen.getByTestId('email-body-html'))
    expect(html.innerHTML).not.toContain('onclick')
    expect(html.innerHTML).not.toContain('style')
    expect(html.innerHTML).toContain('href="https://x.com"')
  })

  it('rejects javascript: URLs even when the server let them through', async () => {
    mockGet.mockResolvedValue({
      emailId: 'e4',
      kind: 'html',
      content: '<a href="javascript:alert(1)">x</a>',
      attachments: [],
    })
    renderWithClient('e4')
    const html = await waitFor(() => screen.getByTestId('email-body-html'))
    expect(html.innerHTML).not.toContain('javascript:')
  })

  it('shows the loading skeleton initially', () => {
    mockGet.mockReturnValue(new Promise(() => {}))
    renderWithClient('e5')
    expect(screen.getByTestId('email-body-loading')).toBeInTheDocument()
  })

  it('shows the retry button on fetch error', async () => {
    mockGet.mockRejectedValue(new Error('boom'))
    renderWithClient('e6')
    await waitFor(() => {
      expect(screen.getByTestId('email-body-error')).toBeInTheDocument()
    })
    expect(screen.getByText('Retry')).toBeInTheDocument()
  })
})
