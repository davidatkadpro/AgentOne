import { useEffect, useState } from 'react'
import { Dialog } from '@/components/ui/Dialog'
import { Input, Textarea } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { api, ApiError } from '@/lib/api'
import { useCreateProject, useNextProjectNumber } from '@/api/projects'

export interface NewProjectDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  onCreated(projectId: string): void
}

type Template = 'empty' | 'aec'

const AEC_PHASES = ['SD', 'DD', 'CD', 'CA']

export function NewProjectDialog({ open, onOpenChange, onCreated }: NewProjectDialogProps) {
  const nextNumber = useNextProjectNumber(open)
  const createProject = useCreateProject()

  const [number, setNumber] = useState('')
  const [name, setName] = useState('')
  const [client, setClient] = useState('')
  const [description, setDescription] = useState('')
  const [template, setTemplate] = useState<Template>('empty')
  const [fieldError, setFieldError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setFieldError(null)
      return
    }
    setNumber('')
    setName('')
    setClient('')
    setDescription('')
    setTemplate('empty')
    setFieldError(null)
  }, [open])

  useEffect(() => {
    if (open && nextNumber.data?.number) {
      setNumber(nextNumber.data.number)
    }
  }, [open, nextNumber.data?.number])

  async function submit() {
    if (!number.trim() || !name.trim()) {
      setFieldError('Number and name are required')
      return
    }
    setFieldError(null)
    try {
      const res = await createProject.mutateAsync({
        number: number.trim(),
        name: name.trim(),
        ...(client.trim() ? { client: client.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      })
      if (template === 'aec') {
        // Best-effort phase seed; if any one POST fails, the project is still
        // created and the user can add the missing phase manually.
        for (const phaseName of AEC_PHASES) {
          try {
            await api.post(`/projects/${res.project.id}/phases`, { name: phaseName })
          } catch {
            /* leave the user with a partial template */
          }
        }
      }
      onCreated(res.project.id)
      onOpenChange(false)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'DUPLICATE_PROJECT_NUMBER') {
        setFieldError(`Project number ${number} is already in use`)
      } else {
        setFieldError(err instanceof Error ? err.message : 'Failed to create project')
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New project">
      <div className="space-y-3">
        <label className="block text-xs text-muted">
          Number
          <Input
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder={nextNumber.data?.number ?? '25001'}
            className="mt-1 font-mono"
            data-testid="new-project-number"
          />
        </label>
        <label className="block text-xs text-muted">
          Name
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Riverside Studio renovation"
            className="mt-1"
            data-testid="new-project-name"
          />
        </label>
        <label className="block text-xs text-muted">
          Client
          <Input
            value={client}
            onChange={(e) => setClient(e.target.value)}
            placeholder="Optional"
            className="mt-1"
          />
        </label>
        <label className="block text-xs text-muted">
          Description
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
            className="mt-1 h-16"
          />
        </label>
        <label className="block text-xs text-muted">
          Phase template
          <select
            value={template}
            onChange={(e) => setTemplate(e.target.value as Template)}
            className="mt-1 h-9 w-full rounded-md border border-border bg-bg px-2 text-sm text-fg"
          >
            <option value="empty">Empty</option>
            <option value="aec">AEC standard (SD / DD / CD / CA)</option>
          </select>
        </label>
        {fieldError ? (
          <div className="text-xs text-danger" role="alert">
            {fieldError}
          </div>
        ) : null}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          onClick={() => void submit()}
          disabled={createProject.isPending}
          data-testid="new-project-submit"
        >
          {createProject.isPending ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </Dialog>
  )
}
