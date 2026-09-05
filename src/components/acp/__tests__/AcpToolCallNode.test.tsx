import type { ComponentProps } from 'react';
import { App } from 'antd';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAcpStore } from '@/stores/acpStore';
import { translateZhCN } from '@/test/i18nTestTranslator';
import { AcpToolCallNode } from '../AcpToolCallNode';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: translateZhCN,
  }),
}));

describe('AcpToolCallNode', () => {
  beforeEach(() => {
    useAcpStore.setState({
      activeThreadId: 'thread-1',
      toolCalls: {
        'thread-1:assistant-1:tool-7': {
          threadId: 'thread-1',
          messageId: 'assistant-1',
          toolCallId: 'tool-7',
          toolName: 'terminal',
          status: 'success',
          input: '{"command":"ls"}',
          output: 'README.md',
          approvalStatus: 'approved',
          approvalOptionId: 'allow_once',
          approvalLabel: 'Allow once',
        },
        'thread-1:assistant-2:tool-7': {
          threadId: 'thread-1',
          messageId: 'assistant-2',
          toolCallId: 'tool-7',
          toolName: 'terminal',
          status: 'success',
          output: '/workspace',
        },
      },
    });
  });

  it('keeps the approval and execution result inside the chronological tool row', () => {
    const props = {
      node: {
        type: 'tool-call',
        content: 'ls',
        attrs: { id: 'tool-7', message: 'assistant-1', name: 'terminal' },
      },
    } as unknown as ComponentProps<typeof AcpToolCallNode>;

    render(
      <App>
        <AcpToolCallNode {...props} />
      </App>,
    );

    const trigger = screen.getByRole('button', { name: /terminal.*已完成.*已批准/i });
    fireEvent.click(trigger);
    expect(screen.getByText('README.md')).toBeInTheDocument();
    expect(screen.queryByText('/workspace')).not.toBeInTheDocument();
    expect(screen.getByText('已批准')).toBeInTheDocument();
  });

  it('exposes tool progress through a polite live region even when details are expandable', () => {
    useAcpStore.setState((state) => ({
      toolCalls: {
        ...state.toolCalls,
        'thread-1:assistant-1:tool-7': {
          ...state.toolCalls['thread-1:assistant-1:tool-7'],
          status: 'running',
        },
      },
    }));
    const props = {
      node: {
        type: 'tool-call',
        content: 'ls',
        attrs: { id: 'tool-7', message: 'assistant-1', name: 'terminal' },
      },
    } as unknown as ComponentProps<typeof AcpToolCallNode>;

    render(
      <App>
        <AcpToolCallNode {...props} />
      </App>,
    );

    const liveRegion = screen.getByRole('status');
    expect(liveRegion).toHaveAttribute('aria-live', 'polite');
    expect(liveRegion).toHaveTextContent('terminal 正在运行');

    act(() => {
      useAcpStore.setState((state) => ({
        toolCalls: {
          ...state.toolCalls,
          'thread-1:assistant-1:tool-7': {
            ...state.toolCalls['thread-1:assistant-1:tool-7'],
            status: 'success',
          },
        },
      }));
    });

    expect(screen.getByRole('status')).toHaveTextContent('terminal 已完成');
  });

  it('localizes a semantic questionnaire action stored as the tool result', () => {
    useAcpStore.setState({
      toolCalls: {
        'thread-1:assistant-3:tool-8': {
          threadId: 'thread-1',
          messageId: 'assistant-3',
          toolCallId: 'tool-8',
          toolName: 'ask_user_question',
          status: 'success',
          output: 'aqbot:questionnaire:skip_interview',
        },
      },
    });
    const props = {
      node: {
        type: 'tool-call',
        content: 'plan interview',
        attrs: { id: 'tool-8', message: 'assistant-3', name: 'ask_user_question' },
      },
    } as unknown as ComponentProps<typeof AcpToolCallNode>;

    render(
      <App>
        <AcpToolCallNode {...props} />
      </App>,
    );

    fireEvent.click(screen.getByRole('button', { name: /ask_user_question.*已完成/i }));
    expect(screen.getByText('跳过提问并开始规划')).toBeInTheDocument();
    expect(screen.queryByText('aqbot:questionnaire:skip_interview')).not.toBeInTheDocument();
  });

  it('localizes a declined questionnaire result without exposing its marker', () => {
    useAcpStore.setState({
      toolCalls: {
        'thread-1:assistant-3:tool-9': {
          threadId: 'thread-1',
          messageId: 'assistant-3',
          toolCallId: 'tool-9',
          toolName: 'elicitation_form',
          status: 'success',
          output: 'aqbot:questionnaire:declined',
        },
      },
    });
    const props = {
      node: {
        type: 'tool-call',
        content: 'standard form',
        attrs: { id: 'tool-9', message: 'assistant-3', name: 'elicitation_form' },
      },
    } as unknown as ComponentProps<typeof AcpToolCallNode>;

    render(
      <App>
        <AcpToolCallNode {...props} />
      </App>,
    );

    fireEvent.click(screen.getByRole('button', { name: /elicitation_form.*已完成/i }));
    expect(screen.getByText('拒绝回答')).toBeInTheDocument();
    expect(screen.queryByText('aqbot:questionnaire:declined')).not.toBeInTheDocument();
  });

  it('decodes XML entities once for a raw block summary', () => {
    const props = {
      node: {
        type: 'tool-call',
        content: 'ls &amp;amp; echo &quot;ok&quot;',
        attrs: { id: 'tool-7', message: 'assistant-1', name: 'terminal' },
      },
    } as unknown as ComponentProps<typeof AcpToolCallNode>;

    render(
      <App>
        <AcpToolCallNode {...props} />
      </App>,
    );

    expect(screen.getByText(/ls &amp; echo "ok"/)).toBeInTheDocument();
  });

  it('does not re-decode an inline summary that already has children', () => {
    const props = {
      node: {
        type: 'tool-call',
        content: 'ls &amp; echo',
        children: [{ type: 'text', content: 'ls &amp; echo', raw: 'ls &amp; echo' }],
        attrs: { id: 'tool-7', message: 'assistant-1', name: 'terminal' },
      },
    } as unknown as ComponentProps<typeof AcpToolCallNode>;

    render(
      <App>
        <AcpToolCallNode {...props} />
      </App>,
    );

    expect(screen.getByText(/ls &amp; echo/)).toBeInTheDocument();
    expect(screen.queryByText(/ls & echo/)).not.toBeInTheDocument();
  });
});
