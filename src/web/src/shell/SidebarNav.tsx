import { NavLink } from 'react-router-dom'
import {
  MessageSquare,
  Mail,
  FolderKanban,
  FileText,
  Receipt,
  StickyNote,
  Sparkles,
  Settings,
} from 'lucide-react'
import { cn } from '@/lib/cn'

interface NavEntry {
  to: string
  label: string
  icon: React.ReactNode
}

const PRIMARY: NavEntry[] = [
  { to: '/chat', label: 'Chat', icon: <MessageSquare size={14} /> },
  { to: '/email', label: 'Email', icon: <Mail size={14} /> },
  { to: '/projects', label: 'Projects', icon: <FolderKanban size={14} /> },
  { to: '/proposals', label: 'Proposals', icon: <FileText size={14} /> },
  { to: '/invoicing', label: 'Invoicing', icon: <Receipt size={14} /> },
]
const SECONDARY: NavEntry[] = [
  { to: '/drafts', label: 'Drafts', icon: <StickyNote size={14} /> },
  { to: '/skills', label: 'Skills', icon: <Sparkles size={14} /> },
  { to: '/settings', label: 'Settings', icon: <Settings size={14} /> },
]

function NavItem({ entry }: { entry: NavEntry }) {
  return (
    <NavLink
      to={entry.to}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-2 px-3 h-10 md:h-8 text-xs rounded-md',
          isActive ? 'bg-surface text-fg' : 'text-muted hover:text-fg hover:bg-surface',
        )
      }
    >
      {entry.icon}
      <span>{entry.label}</span>
    </NavLink>
  )
}

export function SidebarNav() {
  return (
    <nav className="px-2 py-2 space-y-0.5">
      {PRIMARY.map((e) => (
        <NavItem key={e.to} entry={e} />
      ))}
      <div className="h-px bg-border my-2 mx-2" />
      {SECONDARY.map((e) => (
        <NavItem key={e.to} entry={e} />
      ))}
    </nav>
  )
}
