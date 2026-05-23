import { Download, FileText } from 'lucide-react'
import type { EmailAttachmentSummary } from '@/types/domain'
import { attachmentUrl } from '@/api/email'

export interface EmailAttachmentsProps {
  emailId: string
  attachments: EmailAttachmentSummary[]
}

export function EmailAttachments({ emailId, attachments }: EmailAttachmentsProps) {
  if (attachments.length === 0) return null
  return (
    <div className="border-t border-border px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-muted mb-1">Attachments</div>
      <ul className="space-y-1">
        {attachments.map((a) => (
          <li
            key={a.filename}
            className="flex items-center gap-2 text-xs px-2 py-1 bg-surface border border-border rounded"
          >
            <FileText size={12} className="text-muted" />
            <span className="flex-1 truncate" title={a.filename}>
              {a.filename}
            </span>
            <span className="text-[10px] text-muted tabular-nums">{formatBytes(a.bytes)}</span>
            <a
              href={attachmentUrl(emailId, a.filename)}
              download={a.filename}
              className="text-[10px] text-accent hover:underline inline-flex items-center gap-0.5"
              data-testid={`email-attachment-${a.filename}`}
            >
              <Download size={10} /> Download
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}
