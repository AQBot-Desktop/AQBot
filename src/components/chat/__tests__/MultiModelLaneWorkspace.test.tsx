import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from 'antd';
import { emptyMultiModelColumnLayout } from '@/lib/multiModelColumnLayout';
import { useMultiModelColumnLayoutStore } from '@/stores';
import { MultiModelLaneWorkspace } from '../MultiModelLaneWorkspace';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/icons', () => ({
  ModelIcon: ({ model }: { model: string }) => <span data-testid="lane-model-icon">{model}</span>,
}));

vi.mock('overlayscrollbars', () => ({
  OverlayScrollbars: vi.fn((el: HTMLElement) => ({
    destroy: vi.fn(),
    elements: () => ({ viewport: el }),
  })),
}));

const threeColumns = [
  { key: 'provider-a:model-a', providerId: 'provider-a', modelId: 'model-a', historical: false },
  { key: 'provider-b:model-b', providerId: 'provider-b', modelId: 'model-b', historical: false },
  { key: 'provider-c:model-c', providerId: 'provider-c', modelId: 'model-c', historical: false },
] as const;

function renderWorkspace(
  columns: Array<{ key: string; providerId: string; modelId: string; historical: boolean }> = [...threeColumns],
) {
  return render(
    <App>
      <MultiModelLaneWorkspace
        columns={columns}
        getModelDisplayInfo={(modelId) => ({ modelName: modelId ?? 'AI', providerName: '' })}
        renderConversation={(column) => <div>{column.modelId}</div>}
      />
    </App>,
  );
}

function overflowHost(host: HTMLElement) {
  Object.defineProperty(host, 'scrollWidth', { configurable: true, get: () => 1800 });
  Object.defineProperty(host, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(host, 'scrollLeft', { configurable: true, writable: true, value: 0 });
  host.scrollBy = vi.fn();
  act(() => {
    host.dispatchEvent(new Event('scroll'));
  });
  return host;
}

describe('MultiModelLaneWorkspace', () => {
  beforeEach(() => {
    useMultiModelColumnLayoutStore.setState({
      layout: emptyMultiModelColumnLayout(),
      loaded: true,
      error: null,
    });
  });

  it('renders a full conversation pane for each model column', () => {
    render(
      <App>
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
        />
      </App>,
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
      <App>
        <MultiModelLaneWorkspace
          columns={[
            { key: 'provider-a:model-a', providerId: 'provider-a', modelId: 'model-a', historical: false },
            { key: 'provider-b:model-b', providerId: 'provider-b', modelId: 'model-b', historical: false },
            { key: 'provider-c:model-c', providerId: 'provider-c', modelId: 'model-c', historical: false },
          ]}
          getModelDisplayInfo={(modelId) => ({ modelName: modelId ?? 'AI', providerName: '' })}
          renderConversation={(column) => <div>{column.modelId}</div>}
        />
      </App>,
    );

    const column = screen.getByTestId('multi-model-lane-column-provider-a:model-a');
    expect(column).toHaveClass('aqbot-multi-model-card');
    expect(column).toHaveStyle({ flex: '0 0 auto', minWidth: '420px' });
    expect(column.closest('.aqbot-multi-model-lane-scroll')).not.toBeNull();
    expect(column.closest('.aqbot-multi-model-lane-track')).not.toBeNull();
    expect(column.closest('.aqbot-multi-model-lane-track')).toHaveStyle({ gap: '0px' });
  });

  it('lets fit mode share the independent window without prev/next controls', () => {
    useMultiModelColumnLayoutStore.setState({
      layout: {
        ...emptyMultiModelColumnLayout(),
        popoutWidthMode: 'fit',
      },
      loaded: true,
      error: null,
    });
    renderWorkspace();

    const column = screen.getByTestId('multi-model-lane-column-provider-a:model-a');
    expect(column).toHaveClass('aqbot-multi-model-card-fit');
    expect(column).toHaveStyle({ flex: '1 1 0', minWidth: '0px', width: 'auto' });
    expect(column.closest('.aqbot-multi-model-lane-track')).toHaveStyle({ gap: '0px' });
    expect(screen.queryByTestId('multi-model-lane-prev')).not.toBeInTheDocument();
    expect(screen.queryByTestId('multi-model-lane-next')).not.toBeInTheDocument();
  });

  it('scrolls one column at a time with prev/next controls when extra columns overflow', () => {
    renderWorkspace();
    const host = overflowHost(document.querySelector('.aqbot-multi-model-lane-scroll') as HTMLElement);
    host.scrollTo = vi.fn();
    const columns = [...document.querySelectorAll<HTMLElement>('[data-testid^="multi-model-lane-column-"]')];
    Object.defineProperty(columns[0], 'offsetLeft', { configurable: true, value: 0 });
    Object.defineProperty(columns[1], 'offsetLeft', { configurable: true, value: 500 });
    Object.defineProperty(columns[2], 'offsetLeft', { configurable: true, value: 900 });

    expect(screen.getByTestId('multi-model-lane-prev')).toBeDisabled();
    expect(screen.getByTestId('multi-model-lane-next')).toBeEnabled();

    fireEvent.click(screen.getByTestId('multi-model-lane-next'));
    expect(host.scrollTo).toHaveBeenCalledWith({ left: 500, behavior: 'smooth' });
  });

  it('can expand one column and stop a streaming column', () => {
    const onStopColumn = vi.fn();

    render(
      <App>
        <MultiModelLaneWorkspace
          columns={[
            { key: 'provider-a:model-a', providerId: 'provider-a', modelId: 'model-a', historical: false },
            { key: 'provider-b:model-b', providerId: 'provider-b', modelId: 'model-b', historical: false },
          ]}
          getModelDisplayInfo={(modelId) => ({ modelName: modelId ?? 'AI', providerName: '' })}
          renderConversation={(column) => <div>{column.modelId}</div>}
          streamingColumnKeys={new Set(['provider-a:model-a'])}
          onStopColumn={onStopColumn}
        />
      </App>,
    );

    fireEvent.click(screen.getAllByLabelText('chat.multiModel.expandColumn')[0]!);
    expect(screen.getByTestId('multi-model-lane-column-provider-a:model-a')).toBeInTheDocument();
    expect(screen.getByTestId('multi-model-lane-column-provider-b:model-b')).toHaveStyle({ display: 'none' });
    expect(screen.getAllByLabelText('chat.multiModel.collapseColumn')).toHaveLength(1);

    fireEvent.click(screen.getByLabelText('chat.multiModel.stopColumn'));
    expect(onStopColumn).toHaveBeenCalledWith({
      key: 'provider-a:model-a',
      providerId: 'provider-a',
      modelId: 'model-a',
      historical: false,
    });
  });
});
