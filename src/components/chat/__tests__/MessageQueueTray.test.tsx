import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MessageQueueTray, type MessageQueueTrayItem } from '../MessageQueueTray';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'chat.inputQueue.count') return `${options?.count} queued`;
      if (key === 'chat.inputQueue.attachmentSummary') {
        return `${options?.count} attachments: ${options?.names}`;
      }
      if (key === 'chat.inputQueue.removeAttachment') return `remove ${options?.name}`;
      return key;
    },
  }),
}));

const messages: MessageQueueTrayItem[] = [
  {
    id: 'queue-1',
    content: 'first queued message',
    attachments: [
      {
        file_name: 'notes.txt',
        file_type: 'text/plain',
        file_size: 5,
        data: 'aGVsbG8=',
      },
      {
        file_name: 'chart.csv',
        file_type: 'text/csv',
        file_size: 8,
        data: 'YSxi',
      },
    ],
  },
  { id: 'queue-2', content: 'second queued message' },
];

function renderTray(overrides: Partial<React.ComponentProps<typeof MessageQueueTray>> = {}) {
  const props = {
    messages,
    onEdit: vi.fn(),
    onSendNow: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
  return { ...render(<MessageQueueTray {...props} />), props };
}

describe('MessageQueueTray', () => {
  it('renders queued messages in order with attachment and paused state', () => {
    renderTray({ paused: true });

    expect(screen.getByLabelText('chat.inputQueue.label')).toBeInTheDocument();
    expect(screen.getByText('2 queued')).toBeInTheDocument();
    expect(screen.getByText('2 attachments: notes.txt, chart.csv')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('chat.inputQueue.paused');

    const rows = screen.getAllByTestId(/^queued-message-/);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('first queued message');
    expect(rows[1]).toHaveTextContent('second queued message');
  });

  it('sends or deletes the selected queued message', async () => {
    const user = userEvent.setup();
    const { props } = renderTray();
    const secondRow = screen.getByTestId('queued-message-queue-2');

    await user.click(within(secondRow).getByLabelText('chat.inputQueue.sendNow'));
    await user.click(within(secondRow).getByLabelText('chat.inputQueue.delete'));

    expect(props.onSendNow).toHaveBeenCalledWith('queue-2');
    expect(props.onDelete).toHaveBeenCalledWith('queue-2');
  });

  it('edits message text and removes an attachment in the modal', async () => {
    const user = userEvent.setup();
    const { props } = renderTray();

    await user.click(within(screen.getByTestId('queued-message-queue-1'))
      .getByLabelText('chat.inputQueue.edit'));

    const content = screen.getByLabelText('chat.inputQueue.contentLabel');
    expect(content).toHaveValue('first queued message');
    await user.clear(content);
    await user.type(content, 'edited message');
    await user.click(screen.getByLabelText('remove notes.txt'));
    await user.click(screen.getByRole('button', { name: 'common.save' }));

    expect(props.onEdit).toHaveBeenCalledWith('queue-1', {
      content: 'edited message',
      attachments: [expect.objectContaining({ file_name: 'chart.csv' })],
    });
  });

  it('shows a failed queue reason ahead of the paused state', () => {
    renderTray({ paused: true, error: 'backend unavailable' });

    expect(screen.getByRole('status')).toHaveTextContent('backend unavailable');
    expect(screen.getByRole('status')).not.toHaveTextContent('chat.inputQueue.paused');
  });

  it('does not show the message currently being dispatched as queued', () => {
    renderTray({
      messages: [{ id: 'queue-sending', content: 'being sent', status: 'dispatching' }],
    });

    expect(screen.queryByLabelText('chat.inputQueue.label')).not.toBeInTheDocument();
    expect(screen.queryByText('being sent')).not.toBeInTheDocument();
  });

  it('counts and renders only messages still waiting to be sent', () => {
    renderTray({
      messages: [
        { id: 'queue-sending', content: 'being sent', status: 'dispatching' },
        { id: 'queue-waiting', content: 'send me later', status: 'queued' },
        {
          id: 'queue-failed',
          content: 'retry me',
          status: 'failed',
          error: 'dispatch failed',
        },
      ],
    });

    expect(screen.getByText('2 queued')).toBeInTheDocument();
    expect(screen.queryByText('being sent')).not.toBeInTheDocument();
    expect(screen.getByText('send me later')).toBeInTheDocument();
    expect(screen.getByText('retry me')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('dispatch failed');
  });
});
