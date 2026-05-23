import { useEffect, useState } from 'react'
import { useCreateProfile, useUpdateProfile, useDeleteProfile } from '@/api/profiles'
import { Button } from '@/components/ui/Button'
import { Input, Textarea } from '@/components/ui/Input'
import { AlertDialog } from '@/components/ui/Dialog'
import { ApiError } from '@/lib/api'
import type { ProfileListEntry } from '@/types/domain'

export interface ProfileEditorProps {
  profile: ProfileListEntry | null
  bootProfile: string
  onSaved(): void
  onCancelled(): void
  onRequestRestartBanner(): void
}

interface FormState {
  id: string
  description: string
  default_model: string
  default_skills: string  // comma-separated for the form; serialised on submit
  deny_tools: string
}

function emptyForm(): FormState {
  return { id: '', description: '', default_model: 'local-fast', default_skills: '', deny_tools: '' }
}

function profileToForm(p: ProfileListEntry): FormState {
  return {
    id: p.id,
    description: p.description ?? '',
    default_model: p.defaultModel,
    default_skills: p.defaultSkills.join(', '),
    deny_tools: '',
  }
}

export function ProfileEditor({
  profile,
  bootProfile,
  onSaved,
  onCancelled,
  onRequestRestartBanner,
}: ProfileEditorProps) {
  const create = useCreateProfile()
  const update = useUpdateProfile(profile?.id ?? '')
  const del = useDeleteProfile()
  const [form, setForm] = useState<FormState>(profile ? profileToForm(profile) : emptyForm())
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  useEffect(() => {
    setForm(profile ? profileToForm(profile) : emptyForm())
    setFieldErrors({})
    setError(null)
  }, [profile?.id])

  function update_<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function buildBody() {
    const skills = form.default_skills
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const denyTools = form.deny_tools
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const body: Record<string, unknown> = {
      description: form.description || undefined,
      default_model: form.default_model || undefined,
      default_skills: skills,
      deny_tools: denyTools,
    }
    if (!profile) body.id = form.id
    return body
  }

  function applyError(err: unknown) {
    if (err instanceof ApiError) {
      if (Array.isArray(err.details)) {
        const fields: Record<string, string> = {}
        for (const d of err.details as Array<{ path: unknown; message: string }>) {
          const key = Array.isArray(d.path) ? d.path.join('.') : String(d.path)
          fields[key] = d.message
        }
        setFieldErrors(fields)
      }
      setError(err.message)
    } else {
      setError(String(err))
    }
  }

  function save() {
    setError(null)
    setFieldErrors({})
    const body = buildBody()
    if (profile) {
      update.mutate(body, {
        onSuccess: () => {
          if (profile.id === bootProfile) onRequestRestartBanner()
          onSaved()
        },
        onError: applyError,
      })
    } else {
      const createBody = { ...body, id: form.id } as Parameters<typeof create.mutate>[0]
      create.mutate(createBody, {
        onSuccess: onSaved,
        onError: applyError,
      })
    }
  }

  function doDelete() {
    if (!profile) return
    del.mutate(profile.id, {
      onSuccess: () => onCancelled(),
      onError: applyError,
    })
  }

  const isBoot = profile?.id === bootProfile
  const isReserved = profile?.id === '_base'
  const disabled = create.isPending || update.isPending || del.isPending
  const fieldErr = (key: string) => fieldErrors[key]

  return (
    <div className="p-6 max-w-2xl">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold">
          {profile ? `Edit ${profile.id}` : 'New profile'}
        </h2>
        {profile && !isBoot && !isReserved ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmingDelete(true)}
            disabled={disabled}
          >
            <Trash size={12} /> Delete
          </Button>
        ) : null}
      </div>
      {isBoot ? <p className="text-xs text-warn mb-3">This profile is the active boot profile — edits require restart.</p> : null}
      <div className="space-y-3">
        {!profile ? (
          <Field label="Id" error={fieldErr('id')}>
            <Input
              value={form.id}
              onChange={(e) => update_('id', e.target.value)}
              placeholder="ops"
            />
            <p className="text-[10px] text-muted mt-1">Lowercase letters, digits, underscores or hyphens.</p>
          </Field>
        ) : null}
        <Field label="Description" error={fieldErr('description')}>
          <Textarea
            value={form.description}
            onChange={(e) => update_('description', e.target.value)}
            rows={2}
          />
        </Field>
        <Field label="Default model" error={fieldErr('default_model')}>
          <Input
            value={form.default_model}
            onChange={(e) => update_('default_model', e.target.value)}
            placeholder="local-fast"
          />
        </Field>
        <Field label="Default skills" error={fieldErr('default_skills')}>
          <Input
            value={form.default_skills}
            onChange={(e) => update_('default_skills', e.target.value)}
            placeholder="system/filesystem, system/memory"
          />
          <p className="text-[10px] text-muted mt-1">Comma-separated.</p>
        </Field>
        <Field label="Deny tools" error={fieldErr('deny_tools')}>
          <Input
            value={form.deny_tools}
            onChange={(e) => update_('deny_tools', e.target.value)}
            placeholder="filesystem.write_file, filesystem.delete_file"
          />
          <p className="text-[10px] text-muted mt-1">Comma-separated tool ids that this profile cannot call.</p>
        </Field>
        {error ? <div className="text-xs text-danger">{error}</div> : null}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onCancelled} disabled={disabled}>
            Cancel
          </Button>
          <Button onClick={save} disabled={disabled}>
            {disabled ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
      {profile ? (
        <AlertDialog
          open={confirmingDelete}
          onOpenChange={setConfirmingDelete}
          title={`Delete ${profile.id}?`}
          body="The profile YAML will be removed. Sessions bound to this profile won't be touched, but new sessions won't be able to use it."
          confirmLabel="Delete"
          destructive
          onConfirm={doDelete}
        />
      ) : null}
    </div>
  )
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-medium text-fg">{label}</label>
      <div className="mt-1">{children}</div>
      {error ? <div className="text-[10px] text-danger mt-1">{error}</div> : null}
    </div>
  )
}

import { Trash2 as Trash } from 'lucide-react'
