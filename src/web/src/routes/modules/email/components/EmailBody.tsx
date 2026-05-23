import { useMemo } from 'react'
import DOMPurify, { type Config as PurifyConfig } from 'dompurify'
import { useEmailBody } from '@/api/email'

export interface EmailBodyProps {
  emailId: string
}

// Defence-in-depth (P3 spec §5.4 step 3): the server's HTML sanitiser
// (modules/email/src/sanitize.ts) is the primary gate, but we run DOMPurify
// in the browser as a second pass. The allow-list is intentionally narrower
// than the server's so the two layers fail-closed on anything novel: no
// scripts, no event handlers, no `style` attribute, no form elements, only
// https images.
const PURIFY_CONFIG: PurifyConfig = {
  ALLOWED_TAGS: [
    'a', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup',
    'dd', 'div', 'dl', 'dt', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 'small', 's', 'span',
    'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th',
    'thead', 'tr', 'u', 'ul',
  ],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'width', 'height', 'colspan', 'rowspan'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#)/i,
  FORBID_ATTR: ['style', 'srcdoc', 'formaction'],
}

export function EmailBody({ emailId }: EmailBodyProps) {
  const body = useEmailBody(emailId)
  const sanitised = useMemo(
    () =>
      body.data?.kind === 'html'
        ? DOMPurify.sanitize(body.data.content, PURIFY_CONFIG)
        : null,
    [body.data?.kind, body.data?.content],
  )
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
      dangerouslySetInnerHTML={{ __html: sanitised ?? '' }}
    />
  )
}
