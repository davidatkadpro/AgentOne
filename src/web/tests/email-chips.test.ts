import { describe, it, expect, beforeEach } from 'vitest'
import { useEmailChipsStore } from '@/stores/email-chips'

function reset() {
  useEmailChipsStore.setState({ byEmailId: {} })
}

describe('email-chips store', () => {
  beforeEach(reset)

  it('records a running chip on email.action_started', () => {
    useEmailChipsStore.getState().applyEvent({
      type: 'email.action_started',
      emailId: 'e1',
      action: 'file-to-project',
      sessionId: 's1',
      ts: 100,
    })
    const chip = useEmailChipsStore.getState().byEmailId.e1
    expect(chip).toMatchObject({
      emailId: 'e1',
      action: 'file-to-project',
      sessionId: 's1',
      status: 'running',
      startedAt: 100,
    })
  })

  it('replaces a chip when a new action starts on the same email', () => {
    const store = useEmailChipsStore.getState()
    store.applyEvent({
      type: 'email.action_started',
      emailId: 'e1',
      action: 'a',
      sessionId: 's1',
      ts: 100,
    })
    store.applyEvent({
      type: 'email.action_started',
      emailId: 'e1',
      action: 'b',
      sessionId: 's2',
      ts: 200,
    })
    expect(useEmailChipsStore.getState().byEmailId.e1).toMatchObject({
      action: 'b',
      sessionId: 's2',
      startedAt: 200,
    })
  })

  it('completes the chip on email.action_completed (ok)', () => {
    const store = useEmailChipsStore.getState()
    store.applyEvent({
      type: 'email.action_started',
      emailId: 'e1',
      action: 'a',
      sessionId: 's1',
      ts: 100,
    })
    store.applyEvent({
      type: 'email.action_completed',
      emailId: 'e1',
      action: 'a',
      sessionId: 's1',
      ok: true,
      ts: 200,
    })
    expect(useEmailChipsStore.getState().byEmailId.e1).toMatchObject({
      status: 'completed',
      endedAt: 200,
    })
  })

  it('marks failed on email.action_completed (ok: false)', () => {
    const store = useEmailChipsStore.getState()
    store.applyEvent({
      type: 'email.action_started',
      emailId: 'e1',
      action: 'a',
      sessionId: 's1',
      ts: 100,
    })
    store.applyEvent({
      type: 'email.action_completed',
      emailId: 'e1',
      action: 'a',
      sessionId: 's1',
      ok: false,
      ts: 200,
    })
    expect(useEmailChipsStore.getState().byEmailId.e1.status).toBe('failed')
  })

  it('ignores completed events that do not match the current session', () => {
    const store = useEmailChipsStore.getState()
    store.applyEvent({
      type: 'email.action_started',
      emailId: 'e1',
      action: 'a',
      sessionId: 's1',
      ts: 100,
    })
    store.applyEvent({
      type: 'email.action_completed',
      emailId: 'e1',
      action: 'a',
      sessionId: 'different',
      ok: true,
      ts: 200,
    })
    expect(useEmailChipsStore.getState().byEmailId.e1.status).toBe('running')
  })

  it('enriches the chip with projectId on email.filed', () => {
    const store = useEmailChipsStore.getState()
    store.applyEvent({
      type: 'email.action_started',
      emailId: 'e1',
      action: 'file-to-project',
      sessionId: 's1',
      ts: 100,
    })
    store.applyEvent({
      type: 'email.filed',
      emailId: 'e1',
      projectId: 'p-42',
      folderPath: 'projects/24001/in/x',
      ts: 200,
    })
    expect(useEmailChipsStore.getState().byEmailId.e1.result).toMatchObject({
      projectId: 'p-42',
    })
  })

  it('clears a chip on demand', () => {
    const store = useEmailChipsStore.getState()
    store.applyEvent({
      type: 'email.action_started',
      emailId: 'e1',
      action: 'a',
      sessionId: 's1',
      ts: 100,
    })
    store.clear('e1')
    expect(useEmailChipsStore.getState().byEmailId.e1).toBeUndefined()
  })
})
