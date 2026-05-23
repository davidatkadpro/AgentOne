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
import { NotFound } from './routes/NotFound'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
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
      { path: '*', element: <NotFound /> },
    ],
  },
])
