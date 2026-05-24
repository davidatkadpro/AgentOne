import { lazy, Suspense, type ReactElement } from 'react'
import { createBrowserRouter, Navigate } from 'react-router-dom'
import { AppShell } from './shell/AppShell'
import { ChatRoute } from './routes/chat/ChatRoute'
import { NotFound } from './routes/NotFound'
import { RouteSkeleton } from './components/shared/RouteSkeleton'

const DraftsRoute = lazy(() =>
  import('./routes/drafts/DraftsRoute').then((m) => ({ default: m.DraftsRoute })),
)
const SkillsRoute = lazy(() =>
  import('./routes/skills/SkillsRoute').then((m) => ({ default: m.SkillsRoute })),
)
const SettingsRoute = lazy(() =>
  import('./routes/settings/SettingsRoute').then((m) => ({ default: m.SettingsRoute })),
)
const EmailRoute = lazy(() =>
  import('./routes/modules/EmailRoute').then((m) => ({ default: m.EmailRoute })),
)
const ProjectsRoute = lazy(() =>
  import('./routes/modules/ProjectsRoute').then((m) => ({ default: m.ProjectsRoute })),
)
const ProposalsRoute = lazy(() =>
  import('./routes/modules/ProposalsRoute').then((m) => ({ default: m.ProposalsRoute })),
)
const InvoicingRoute = lazy(() =>
  import('./routes/modules/InvoicingRoute').then((m) => ({ default: m.InvoicingRoute })),
)

function lazyElement(node: ReactElement): ReactElement {
  return <Suspense fallback={<RouteSkeleton variant="list" />}>{node}</Suspense>
}

const baseChildren = [
  { index: true, element: <Navigate to="/chat" replace /> },
  { path: 'chat', element: <ChatRoute /> },
  { path: 'chat/:sessionId', element: <ChatRoute /> },
  { path: 'email', element: lazyElement(<EmailRoute />) },
  { path: 'email/:emailId', element: lazyElement(<EmailRoute />) },
  { path: 'projects', element: lazyElement(<ProjectsRoute />) },
  { path: 'projects/:projectId', element: lazyElement(<ProjectsRoute />) },
  { path: 'proposals', element: lazyElement(<ProposalsRoute />) },
  { path: 'proposals/:proposalId', element: lazyElement(<ProposalsRoute />) },
  { path: 'invoicing', element: lazyElement(<InvoicingRoute />) },
  { path: 'invoicing/:invoiceId', element: lazyElement(<InvoicingRoute />) },
  { path: 'drafts', element: lazyElement(<DraftsRoute />) },
  { path: 'skills', element: lazyElement(<SkillsRoute />) },
  { path: 'settings', element: lazyElement(<SettingsRoute />) },
]

// Dev-only sandbox at /__dev/components. Tree-shaken from production builds
// by Vite when import.meta.env.DEV is false.
const ComponentsRoute = import.meta.env.DEV
  ? lazy(() =>
      import('./routes/dev/ComponentsRoute').then((m) => ({ default: m.ComponentsRoute })),
    )
  : null

const devChildren = ComponentsRoute
  ? [{ path: '__dev/components', element: lazyElement(<ComponentsRoute />) }]
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
