import { lazy, Suspense, type ReactNode } from 'react'

const LazyMarkdown = lazy(async () => {
  const [{ default: ReactMarkdown }, { default: remarkGfm }, { default: rehypeHighlight }] =
    await Promise.all([
      import('react-markdown'),
      import('remark-gfm'),
      import('rehype-highlight'),
    ])
  function Inner({
    content,
    highlight,
    components,
  }: {
    content: string
    highlight: boolean
    components?: Record<string, unknown>
  }) {
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={highlight ? [rehypeHighlight] : []}
        components={components as never}
      >
        {content}
      </ReactMarkdown>
    )
  }
  return { default: Inner }
})

export interface MarkdownViewProps {
  content: string
  highlight?: boolean
  components?: Record<string, unknown>
  fallback?: ReactNode
}

export function MarkdownView({ content, highlight = false, components, fallback }: MarkdownViewProps) {
  return (
    <Suspense fallback={fallback ?? <span className="whitespace-pre-wrap">{content}</span>}>
      <LazyMarkdown content={content} highlight={highlight} components={components} />
    </Suspense>
  )
}
