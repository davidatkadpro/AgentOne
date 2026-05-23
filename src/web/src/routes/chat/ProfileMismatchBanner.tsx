import { Button } from '@/components/ui/Button'

export interface ProfileMismatchBannerProps {
  requiredProfile: string
}

export function ProfileMismatchBanner({ requiredProfile }: ProfileMismatchBannerProps) {
  const cmd = `AGENT_PROFILE=${requiredProfile} npm run dev`
  return (
    <div className="bg-warn/10 border-b border-warn/30 px-6 py-2 text-xs flex items-center gap-3">
      <span className="text-warn font-semibold">Profile mismatch</span>
      <span className="text-muted">
        This session was created under profile <code className="font-mono">{requiredProfile}</code>. Restart the server with the matching profile to message it.
      </span>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          if (typeof navigator !== 'undefined') {
            void navigator.clipboard?.writeText(cmd)
          }
        }}
      >
        Copy restart command
      </Button>
    </div>
  )
}
