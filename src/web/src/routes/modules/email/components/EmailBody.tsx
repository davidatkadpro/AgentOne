import { useEmailBody } from '@/api/email'

export interface EmailBodyProps {
  emailId: string
}

/**
 * Renders the email body. Server-side sanitisation (modules/email/src/sanitize.ts)
 * is the primary defence — by the time the bytes reach the browser, scripts
 * and dangerous attributes are gone. Without a heavy DOMPurify dep, we render
 * the trusted server output inside a constrained container; the single-user
 * trust model and the server pass make this acceptable for v2.
 */
export function EmailBody({ emailId }: EmailBodyProps) {
  const body = useEmailBody(emailId)
  if (body.isLoading) {
    return (
      <div className="p-6 space-y-2" data-testid="email-body-loading">
        <div className="h-3 w-3/4 rounded bg-border animate-pulse" />
        <div className="h-3 w-2/3 rounded bg-border animate-pulse" />
        <div className="h-3 w-1/2 rounded bg-border animate-pulse" />
      </div>
    )
  }
  if (body.isError) {
    return (
      <div className="p-6 text-sm text-danger" data-testid="email-body-error">
        Body unavailable.{' '}
        <button
          onClick={() => void body.refetch()}
          className="text-accent hover:underline"
        >
          Retry
        </button>
      </div>
    )
  }
  const data = body.data
  if (!data) {
    return (
      <div className="p-6 text-sm text-muted italic">
        This email's body is no longer available from the source.
      </div>
    )
  }
  if (data.kind === 'text') {
    return (
      <pre
        className="p-4 text-sm whitespace-pre-wrap break-words font-sans text-fg"
        data-testid="email-body-text"
      >
        {data.content}
      </pre>
    )
  }
  return (
    <div
      className="email-body p-4 text-sm prose-sm max-w-none text-fg"
      data-testid="email-body-html"
      dangerouslySetInnerHTML={{ __html: data.content }}
    />
  )
}
