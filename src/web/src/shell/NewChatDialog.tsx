import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useProfiles } from '@/api/profiles'
import { useCreateSession } from '@/api/sessions'
import { useUiStore } from '@/stores/ui'
import { ApiError } from '@/lib/api'

export function NewChatDialog() {
  const navigate = useNavigate()
  const { newChatDialogOpen: open, setNewChatDialogOpen: setOpen } = useUiStore()
  const profiles = useProfiles()
  const create = useCreateSession()
  const [title, setTitle] = useState('')
  const bootProfile = profiles.data?.current ?? '_base'
  const [error, setError] = useState<string | null>(null)

  function handleCreate() {
    setError(null)
    create.mutate(
      { title: title || null, agentProfile: bootProfile },
      {
        onSuccess: (res) => {
          setTitle('')
          setOpen(false)
          navigate(`/chat/${res.session.id}`)
        },
        onError: (err) => {
          if (err instanceof ApiError) setError(err.message)
          else setError(String(err))
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen} title="New conversation">
      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium text-muted">Title (optional)</label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Untitled"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted">Profile</label>
          <div className="mt-1 p-2 text-xs rounded-md bg-bg border border-border">
            <div className="font-medium text-fg">{bootProfile}</div>
            <div className="text-muted">
              Profile is fixed per server boot —{' '}
              <Link
                to="/settings?tab=profiles"
                onClick={() => setOpen(false)}
                className="text-accent hover:underline"
              >
                Manage profiles
              </Link>
            </div>
          </div>
        </div>
        {error ? <div className="text-xs text-danger">{error}</div> : null}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
