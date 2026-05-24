import { describe, it, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// Mock the profile mutation hooks before importing the component so the
// test doesn't try to hit a real /api endpoint.
const createMutate = vi.fn()
const updateMutate = vi.fn()

vi.mock('@/api/profiles', () => ({
  useCreateProfile: () => ({ mutate: createMutate, isPending: false }),
  useUpdateProfile: () => ({ mutate: updateMutate, isPending: false }),
  useDeleteProfile: () => ({ mutate: vi.fn(), isPending: false }),
}))

import { ProfileEditor } from '@/routes/settings/ProfileEditor'

function withQuery(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>
}

describe('ProfileEditor — react-hook-form migration', () => {
  it('rejects an invalid id on submit and blocks the mutation', async () => {
    render(
      withQuery(
        <ProfileEditor
          profile={null}
          bootProfile="boot"
          onSaved={() => {}}
          onCancelled={() => {}}
          onRequestRestartBanner={() => {}}
        />,
      ),
    )
    const idField = screen.getByTestId('profile-field-id')
    fireEvent.change(idField, { target: { value: 'Bad Id!' } })
    fireEvent.click(screen.getByTestId('profile-save'))
    // Validation error rendered inline.
    await waitFor(() => {
      expect(screen.getByText(/lowercase letters/i)).toBeInTheDocument()
    })
    expect(createMutate).not.toHaveBeenCalled()
  })

  it('blocks save when default_model is empty', async () => {
    render(
      withQuery(
        <ProfileEditor
          profile={null}
          bootProfile="boot"
          onSaved={() => {}}
          onCancelled={() => {}}
          onRequestRestartBanner={() => {}}
        />,
      ),
    )
    fireEvent.change(screen.getByTestId('profile-field-id'), {
      target: { value: 'ops' },
    })
    fireEvent.change(screen.getByTestId('profile-field-default-model'), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByTestId('profile-save'))
    await waitFor(() => {
      expect(screen.getByText(/required/i)).toBeInTheDocument()
    })
    expect(createMutate).not.toHaveBeenCalled()
  })

  it('disables Save when an existing profile has not been edited', () => {
    render(
      withQuery(
        <ProfileEditor
          profile={{
            id: 'ops',
            description: 'desc',
            defaultModel: 'local-fast',
            defaultSkills: [],
            ok: true,
          }}
          bootProfile="boot"
          onSaved={() => {}}
          onCancelled={() => {}}
          onRequestRestartBanner={() => {}}
        />,
      ),
    )
    expect(screen.getByTestId('profile-save')).toBeDisabled()
  })
})
