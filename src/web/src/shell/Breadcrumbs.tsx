import { Fragment } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { useProject } from '@/api/projects'
import { useInvoice } from '@/api/invoicing'
import { useEmail } from '@/api/email'
import { useProposalDetail } from '@/api/proposals'
import { useSession } from '@/api/sessions'

const SECTION_LABEL: Record<string, string> = {
  chat: 'Chat',
  email: 'Email',
  projects: 'Projects',
  proposals: 'Proposals',
  invoicing: 'Invoicing',
  drafts: 'Drafts',
  skills: 'Skills',
  settings: 'Settings',
}

interface Crumb {
  to: string
  /** Pre-resolved static label, or a section key that picks a dynamic component. */
  label: string | null
  section?: keyof typeof DYNAMIC_LABELS
  id?: string
}

const DYNAMIC_LABELS = {
  chat: ChatCrumb,
  projects: ProjectCrumb,
  invoicing: InvoiceCrumb,
  email: EmailCrumb,
  proposals: ProposalCrumb,
} as const

function ChatCrumb({ id }: { id: string }) {
  const session = useSession(id)
  const title = session.data?.session.title?.trim()
  return <>{title || id.slice(0, 4)}</>
}

function ProjectCrumb({ id }: { id: string }) {
  const project = useProject(id)
  if (!project.data) return <>{id.slice(0, 8)}</>
  return (
    <>
      #{project.data.project.number} — {project.data.project.name}
    </>
  )
}

function InvoiceCrumb({ id }: { id: string }) {
  const invoice = useInvoice(id)
  if (!invoice.data) return <>{id.slice(0, 8)}</>
  return <>#{invoice.data.invoice.number}</>
}

function EmailCrumb({ id }: { id: string }) {
  const email = useEmail(id)
  if (!email.data) return <>{id.slice(0, 8)}</>
  return <>{email.data.email.subject?.trim() || email.data.email.fromAddress}</>
}

function ProposalCrumb({ id }: { id: string }) {
  const detail = useProposalDetail(id)
  if (!detail.data) return <>{id.slice(0, 8)}</>
  if (detail.data.proposal) return <>#{detail.data.proposal.number}</>
  return <>Estimate v{detail.data.estimate.version}</>
}

function parseCrumbs(pathname: string): Crumb[] {
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length === 0) return []

  const out: Crumb[] = []
  const section = segments[0]
  const sectionLabel = SECTION_LABEL[section]
  if (!sectionLabel) return []

  out.push({ to: `/${section}`, label: sectionLabel })

  if (segments.length >= 2) {
    const id = segments[1]
    if (section in DYNAMIC_LABELS) {
      out.push({
        to: `/${section}/${id}`,
        label: null,
        section: section as keyof typeof DYNAMIC_LABELS,
        id,
      })
    }
  }

  return out
}

export function Breadcrumbs() {
  const location = useLocation()
  const crumbs = parseCrumbs(location.pathname)
  if (crumbs.length === 0) return null

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-xs min-w-0 flex-1">
      {crumbs.map((crumb, i) => {
        const isLast = i === crumbs.length - 1
        const label = crumb.label ? (
          crumb.label
        ) : crumb.section && crumb.id ? (
          (() => {
            const Comp = DYNAMIC_LABELS[crumb.section]
            return <Comp id={crumb.id} />
          })()
        ) : null
        return (
          <Fragment key={`${crumb.to}-${i}`}>
            {i > 0 ? <ChevronRight size={12} className="text-muted shrink-0" /> : null}
            {isLast ? (
              <span className="text-fg font-medium truncate">{label}</span>
            ) : (
              <Link to={crumb.to} className="text-muted hover:text-fg truncate">
                {label}
              </Link>
            )}
          </Fragment>
        )
      })}
    </nav>
  )
}
