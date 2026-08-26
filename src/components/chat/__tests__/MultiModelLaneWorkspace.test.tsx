import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MultiModelLaneWorkspace } from '../MultiModelLaneWorkspace';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/icons', () => ({
  ModelIcon: ({ model }: { model: string }) => <span data-testid="lane-model-icon">{model}</span>,
}));

describe('MultiModelLaneWorkspace', () => {
  it('renders a full conversation pane for each model column', () => {
    render(
      <MultiModelLaneWorkspace
        columns={[
          { key: 'provider-a:model-a', providerId: 'provider-a', modelId: 'model-a', historical: false },
          { key: 'provider-b:model-b', providerId: 'provider-b', modelId: 'model-b', historical: false },
        ]}
        getModelDisplayInfo={(modelId, providerId) => ({
          modelName: modelId ?? 'AI',
          providerName: providerId === 'provider-a' ? 'Provider A' : 'Provider B',
        })}
        renderConversation={(column) => <div>{`conversation:${column.modelId}`}</div>}
      />,
    );

    expect(screen.getByTestId('multi-model-lane-workspace')).toBeInTheDocument();
    expect(screen.getByText('conversation:model-a')).toBeInTheDocument();
    expect(screen.getByText('conversation:model-b')).toBeInTheDocument();
    expect(screen.getAllByText('model-a').length).toBeGreaterThan(0);
    expect(screen.getAllByText('model-b').length).toBeGreaterThan(0);
    expect(screen.getByText('Provider A')).toBeInTheDocument();
    expect(screen.getByText('Provider B')).toBeInTheDocument();
    expect(screen.queryByText('Provider A · model-a')).not.toBeInTheDocument();
    expect(screen.getAllByLabelText('chat.multiModel.expandColumn')).toHaveLength(2);
  });

  it('sizes extra columns like a two-column workspace instead of 1/n of the window', () => {
    render(
      <MultiModelLaneWorkspace
        columns={[
          { key: 'provider-a:model-a', providerId: 'provider-a', modelId: 'model-a', historical: false },
          { key: 'provider-b:model-b', providerId: 'provider-b', modelId: 'model-b', historical: false },
          { key: 'provider-c:model-c', providerId: 'provider-c', modelId: 'model-c', historical: false },
        ]}
        getModelDisplayInfo={(modelId) => ({ modelName: modelId ?? 'AI', providerName: '' })}
        renderConversation={(column) => <div>{column.modelId}</div>}
      />,
    );

    const column = screen.getByTestId('multi-model-lane-column-provider-a:model-a');
    expect(column).toHaveClass('aqbot-multi-model-card');
    expect(column).toHaveStyle({ flex: '0 0 auto', minWidth: '420px' });
    expect(column.closest('.aqbot-multi-model-lane-scroll')).not.toBeNull();
  });

  it('can expand one column and stop a streaming column', () => {
    const onStopColumn = vi.fn();

    render(
      <MultiModelLaneWorkspace
        columns={[
          { key: 'provider-a:model-a', providerId: 'provider-a', modelId: 'model-a', historical: false },
          { key: 'provider-b:model-b', providerId: 'provider-b', modelId: 'model-b', historical: false },
        ]}
        getModelDisplayInfo={(modelId) => ({ modelName: modelId ?? 'AI', providerName: '' })}
        renderConversation={(column) => <div>{column.modelId}</div>}
        streamingColumnKeys={new Set(['provider-a:model-a'])}
        onStopColumn={onStopColumn}
      />,
    );

    fireEvent.click(screen.getAllByLabelText('chat.multiModel.expandColumn')[0]!);
    expect(screen.getByTestId('multi-model-lane-column-provider-a:model-a')).toBeInTheDocument();
    expect(screen.queryByTestId('multi-model-lane-column-provider-b:model-b')).not.toBeInTheDocument();
    expect(screen.getByLabelText('chat.multiModel.collapseColumn')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('chat.multiModel.stopColumn'));
    expect(onStopColumn).toHaveBeenCalledWith({
      key: 'provider-a:model-a',
      providerId: 'provider-a',
      modelId: 'model-a',
      historical: false,
    });
  });
});
