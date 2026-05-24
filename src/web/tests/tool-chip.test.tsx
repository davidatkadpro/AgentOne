import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ToolChip } from '@/routes/chat/ToolChip'

describe('ToolChip', () => {
  it('renders the tool name and a check icon when done', () => {
    render(
      <ToolChip
        chip={{
          toolCallId: 'a',
          tool: 'read_file',
          status: 'done',
          durationMs: 42,
        }}
      />,
    )
    const chip = screen.getByTestId('tool-chip')
    expect(chip).toHaveTextContent('read_file')
    expect(chip.getAttribute('data-status')).toBe('done')
  })

  it('opens a popover with args + result on click', () => {
    render(
      <ToolChip
        chip={{
          toolCallId: 'a',
          tool: 'read_file',
          status: 'done',
          durationMs: 42,
          args: { path: '/etc/hosts' },
          result: { content: 'localhost' },
        }}
      />,
    )
    expect(screen.queryByTestId('tool-chip-popover')).toBeNull()
    fireEvent.click(screen.getByTestId('tool-chip'))
    expect(screen.getByTestId('tool-chip-popover')).toBeInTheDocument()
    expect(screen.getByTestId('tool-chip-args')).toHaveTextContent('/etc/hosts')
    expect(screen.getByTestId('tool-chip-result')).toHaveTextContent('localhost')
  })

  it('shows failCode + failMessage when failed', () => {
    render(
      <ToolChip
        chip={{
          toolCallId: 'a',
          tool: 'shell',
          status: 'failed',
          failCode: 'TOOL_TIMEOUT',
          failMessage: 'exceeded budget',
        }}
      />,
    )
    fireEvent.click(screen.getByTestId('tool-chip'))
    const pop = screen.getByTestId('tool-chip-popover')
    expect(pop).toHaveTextContent('TOOL_TIMEOUT')
    expect(pop).toHaveTextContent('exceeded budget')
  })

  it('does not open a popover for a pending chip with no args/result', () => {
    render(
      <ToolChip
        chip={{ toolCallId: 'a', tool: 'pending', status: 'pending' }}
      />,
    )
    fireEvent.click(screen.getByTestId('tool-chip'))
    expect(screen.queryByTestId('tool-chip-popover')).toBeNull()
  })

  it('closes the popover on Escape', () => {
    render(
      <ToolChip
        chip={{
          toolCallId: 'a',
          tool: 'read_file',
          status: 'done',
          args: { path: 'x' },
        }}
      />,
    )
    fireEvent.click(screen.getByTestId('tool-chip'))
    expect(screen.getByTestId('tool-chip-popover')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('tool-chip-popover')).toBeNull()
  })
})
