import { createBrowserRouter, Navigate } from 'react-router-dom'
import { AppShell } from './shell/AppShell'
import { ChatRoute } from './routes/chat/ChatRoute'
import { DraftsRoute } from './routes/drafts/DraftsRoute'
import { SkillsRoute } from './routes/skills/SkillsRoute'
import { SettingsRoute } from './routes/settings/SettingsRoute'
import { EmailRoute } from './routes/modules/EmailRoute'
import { ProjectsRoute } from './routes/modules/ProjectsRoute'
import { ProposalsRoute } from './routes/modules/ProposalsRoute'
import { InvoicingRoute } from './routes/modules/InvoicingRoute'
import { ComponentsRoute } from './routes/dev/ComponentsRoute'
import { NotFound } from './routes/NotFound'

const baseChildren = [
  { index: true, element: <Navigate to="/chat" replace /> },
  { path: 'chat', element: <ChatRoute /> },
  { path: 'chat/:sessionId', element: <ChatRoute /> },
  { path: 'email', element: <EmailRoute /> },
  { path: 'email/:emailId', element: <EmailRoute /> },
  { path: 'projects', element: <ProjectsRoute /> },
  { path: 'projects/:projectId', element: <ProjectsRoute /> },
  { path: 'proposals', element: <ProposalsRoute /> },
  { path: 'proposals/:proposalId', element: <ProposalsRoute /> },
  { path: 'invoicing', element: <InvoicingRoute /> },
  { path: 'invoicing/:invoiceId', element: <InvoicingRoute /> },
  { path: 'drafts', element: <DraftsRoute /> },
  { path: 'skills', element: <SkillsRoute /> },
  { path: 'settings', element: <SettingsRoute /> },
]

// Dev-only sandbox at /__dev/components. Tree-shaken from production builds
// by Vite when import.meta.env.DEV is false.
const devChildren = import.meta.env.DEV
  ? [{ path: '__dev/components', element: <ComponentsRoute /> }]
  : []

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      ...baseChildren,
      ...devChildren,
      { path: '*', element: <NotFound /> },
    ],
  },
])
