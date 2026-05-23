import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { MemoryRouter, useSearchParams } from 'react-router-dom'
import { useProjectDeepLink } from '@/routes/modules/projects/hooks/useProjectDeepLink'

function withRouter(initialEntries: string[]) {
  return ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
  )
}

describe('useProjectDeepLink', () => {
  it('defaults to the tasks tab', () => {
    const { result } = renderHook(() => useProjectDeepLink(), {
      wrapper: withRouter(['/projects/p1']),
    })
    expect(result.current.tab).toBe('tasks')
    expect(result.current.taskId).toBeNull()
  })

  it('falls back to tasks when ?tab=invalid', () => {
    const { result } = renderHook(() => useProjectDeepLink(), {
      wrapper: withRouter(['/projects/p1?tab=zzz']),
    })
    expect(result.current.tab).toBe('tasks')
  })

  it('reads ?tab= and ?task= from the URL', () => {
    const { result } = renderHook(() => useProjectDeepLink(), {
      wrapper: withRouter(['/projects/p1?tab=tasks&task=t-42']),
    })
    expect(result.current.tab).toBe('tasks')
    expect(result.current.taskId).toBe('t-42')
  })

  it('setTab updates the URL', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <MemoryRouter initialEntries={['/projects/p1']}>{children}</MemoryRouter>
    )
    const { result } = renderHook(
      () => {
        const link = useProjectDeepLink()
        const [params] = useSearchParams()
        return { link, params }
      },
      { wrapper },
    )
    act(() => result.current.link.setTab('activity'))
    expect(result.current.params.get('tab')).toBe('activity')
    act(() => result.current.link.setTab('tasks'))
    expect(result.current.params.get('tab')).toBeNull()
  })

  it('setTaskId open/close round-trip', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <MemoryRouter initialEntries={['/projects/p1?tab=tasks']}>{children}</MemoryRouter>
    )
    const { result } = renderHook(
      () => {
        const link = useProjectDeepLink()
        const [params] = useSearchParams()
        return { link, params }
      },
      { wrapper },
    )
    act(() => result.current.link.open('t-1'))
    expect(result.current.params.get('task')).toBe('t-1')
    act(() => result.current.link.close())
    expect(result.current.params.get('task')).toBeNull()
  })

  it('clears task when switching away from the tasks tab', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <MemoryRouter initialEntries={['/projects/p1?tab=tasks&task=t-1']}>
        {children}
      </MemoryRouter>
    )
    const { result } = renderHook(
      () => {
        const link = useProjectDeepLink()
        const [params] = useSearchParams()
        return { link, params }
      },
      { wrapper },
    )
    act(() => result.current.link.setTab('activity'))
    expect(result.current.params.get('task')).toBeNull()
  })
})
