import { useEffect, useState } from 'react'
import { useForm, type SubmitHandler } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Trash2 as Trash } from 'lucide-react'
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

// Form-side schema. The server's profile schema is authoritative — this
// mirrors the *client-validatable* subset and lets us catch typos before the
// round-trip. Server validation errors map back via setError() below.
const FormSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9_-]+$/, 'Lowercase letters, digits, underscores or hyphens'),
  description: z.string().optional(),
  default_model: z.string().min(1, 'Required'),
  default_skills: z.string().optional(),
  deny_tools: z.string().optional(),
})

type FormValues = z.infer<typeof FormSchema>

function emptyValues(): FormValues {
  return { id: '', description: '', default_model: 'local-fast', default_skills: '', deny_tools: '' }
}

function profileToValues(p: ProfileListEntry): FormValues {
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
  const [serverError, setServerError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const {
    register,
    handleSubmit,
    formState: { errors, isDirty, isSubmitting },
    reset,
    setError,
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: profile ? profileToValues(profile) : emptyValues(),
    mode: 'onBlur',
  })

  // Reset the form whenever we switch to editing a different profile.
  useEffect(() => {
    reset(profile ? profileToValues(profile) : emptyValues())
    setServerError(null)
  }, [profile?.id, reset, profile])

  function applyServerError(err: unknown) {
    if (err instanceof ApiError) {
      if (Array.isArray(err.details)) {
        for (const d of err.details as Array<{ path: unknown; message: string }>) {
          const key = Array.isArray(d.path) ? d.path.join('.') : String(d.path)
          if (key in FormSchema.shape) {
            setError(key as keyof FormValues, { type: 'server', message: d.message })
          }
        }
      }
      setServerError(err.message)
    } else {
      setServerError(err instanceof Error ? err.message : String(err))
    }
  }

  const onSubmit: SubmitHandler<FormValues> = (values) => {
    setServerError(null)
    const skills = (values.default_skills ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const denyTools = (values.deny_tools ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const body: Record<string, unknown> = {
      description: values.description || undefined,
      default_model: values.default_model || undefined,
      default_skills: skills,
      deny_tools: denyTools,
    }
    if (profile) {
      update.mutate(body, {
        onSuccess: () => {
          if (profile.id === bootProfile) onRequestRestartBanner()
          onSaved()
        },
        onError: applyServerError,
      })
    } else {
      const createBody = { ...body, id: values.id } as Parameters<typeof create.mutate>[0]
      create.mutate(createBody, {
        onSuccess: onSaved,
        onError: applyServerError,
      })
    }
  }

  function doDelete() {
    if (!profile) return
    del.mutate(profile.id, {
      onSuccess: () => onCancelled(),
      onError: applyServerError,
    })
  }

  const isBoot = profile?.id === bootProfile
  const isReserved = profile?.id === '_base'
  const busy = isSubmitting || create.isPending || update.isPending || del.isPending

  return (
    <div className="p-6 max-w-2xl" data-testid="profile-editor">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold">
          {profile ? `Edit ${profile.id}` : 'New profile'}
        </h2>
        {profile && !isBoot && !isReserved ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmingDelete(true)}
            disabled={busy}
          >
            <Trash size={12} /> Delete
          </Button>
        ) : null}
      </div>
      {isBoot ? (
        <p className="text-xs text-warn mb-3">
          This profile is the active boot profile — edits require restart.
        </p>
      ) : null}
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-3" noValidate>
        {!profile ? (
          <Field label="Id" error={errors.id?.message}>
            <Input
              {...register('id')}
              placeholder="ops"
              data-testid="profile-field-id"
            />
            <p className="text-[10px] text-muted mt-1">
              Lowercase letters, digits, underscores or hyphens.
            </p>
          </Field>
        ) : null}
        <Field label="Description" error={errors.description?.message}>
          <Textarea
            {...register('description')}
            rows={2}
            data-testid="profile-field-description"
          />
        </Field>
        <Field label="Default model" error={errors.default_model?.message}>
          <Input
            {...register('default_model')}
            placeholder="local-fast"
            data-testid="profile-field-default-model"
          />
        </Field>
        <Field label="Default skills" error={errors.default_skills?.message}>
          <Input
            {...register('default_skills')}
            placeholder="system/filesystem, system/memory"
            data-testid="profile-field-default-skills"
          />
          <p className="text-[10px] text-muted mt-1">Comma-separated.</p>
        </Field>
        <Field label="Deny tools" error={errors.deny_tools?.message}>
          <Input
            {...register('deny_tools')}
            placeholder="filesystem.write_file, filesystem.delete_file"
            data-testid="profile-field-deny-tools"
          />
          <p className="text-[10px] text-muted mt-1">
            Comma-separated tool ids that this profile cannot call.
          </p>
        </Field>
        {serverError ? (
          <div className="text-xs text-danger" data-testid="profile-server-error">
            {serverError}
          </div>
        ) : null}
        <div className="flex justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="secondary"
            onClick={onCancelled}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={busy || (!isDirty && !!profile)}
            data-testid="profile-save"
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
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
