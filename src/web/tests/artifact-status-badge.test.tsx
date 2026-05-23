import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ArtifactStatusBadge } from '@/routes/modules/proposals/components/ArtifactStatusBadge'

describe('ArtifactStatusBadge', () => {
  it('renders Estimate · draft with the warn tone', () => {
    render(<ArtifactStatusBadge displayStatus="Estimate · draft" />)
    const node = screen.getByTestId('artifact-status-badge')
    expect(node).toHaveTextContent('Estimate · draft')
    expect(node.className).toMatch(/warn/)
  })

  it('renders Proposal · issued with the indigo tone', () => {
    render(<ArtifactStatusBadge displayStatus="Proposal · issued" />)
    const node = screen.getByTestId('artifact-status-badge')
    expect(node.className).toMatch(/indigo/)
  })

  it('strikes through superseded artifacts', () => {
    render(<ArtifactStatusBadge displayStatus="Proposal · superseded" />)
    expect(screen.getByTestId('artifact-status-badge').className).toContain('line-through')
  })

  it('uses the muted accepted tone for emerald wins', () => {
    render(<ArtifactStatusBadge displayStatus="Proposal · accepted" />)
    const node = screen.getByTestId('artifact-status-badge')
    expect(node.className).toMatch(/emerald/)
  })

  it('falls back gracefully for unknown statuses', () => {
    render(<ArtifactStatusBadge displayStatus="Estimate · unknown" />)
    const node = screen.getByTestId('artifact-status-badge')
    // No crash; falls back to neutral fallback style.
    expect(node).toHaveTextContent('Estimate · unknown')
  })

  it('adds the muted treatment when frozen is true', () => {
    render(<ArtifactStatusBadge displayStatus="Proposal · issued" frozen />)
    expect(screen.getByTestId('artifact-status-badge').className).toMatch(/opacity-80/)
  })
})
