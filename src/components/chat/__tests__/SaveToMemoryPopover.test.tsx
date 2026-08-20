import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryItem, MemoryNamespace } from '@/types';
import { SaveToMemoryPopover } from '../SaveToMemoryPopover';

const mocks = vi.hoisted(() => {
  const ensureNamespacesLoaded = vi.fn(async () => {});
  const loadNamespaces = vi.fn(async () => {});
  const saveText = vi.fn();
  const setActivePage = vi.fn();

  return {
    ensureNamespacesLoaded,
    loadNamespaces,
    saveText,
    setActivePage,
    message: {
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    },
    memoryState: {
      namespaces: [] as MemoryNamespace[],
      namespacesMeta: {
        status: 'ready' as 'idle' | 'loading' | 'ready' | 'error',
        key: 'memory-namespaces' as string | null,
        loadedAt: 1 as number | null,
        revision: 0,
      },
      error: null as string | null,
      ensureNamespacesLoaded,
      loadNamespaces,
      saveText,
    },
    uiState: { setActivePage },
  };
});

vi.mock('@/stores', () => ({
  useMemoryStore: (selector: (state: typeof mocks.memoryState) => unknown) => (
    selector(mocks.memoryState)
  ),
  useUIStore: (selector: (state: typeof mocks.uiState) => unknown) => (
    selector(mocks.uiState)
  ),
}));

vi.mock('@/components/shared/NamespaceIcon', () => ({
  NamespaceIcon: ({ ns }: { ns: MemoryNamespace }) => (
    <span data-testid={`namespace-icon-${ns.id}`} />
  ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === 'chat.memory.loadFailed') return `load failed: ${values?.error ?? ''}`;
      if (key === 'chat.memory.saveFailed') return `save failed: ${values?.error ?? ''}`;
      if (key === 'chat.memory.saveSuccess') return `saved: ${values?.namespace ?? ''}`;
      if (key === 'chat.memory.saveSkipped') return `skipped: ${values?.namespace ?? ''}`;
      return key;
    },
  }),
}));

vi.mock('antd', () => ({
  App: {
    useApp: () => ({ message: mocks.message }),
  },
  Button: ({
    children,
    disabled,
    loading,
    onClick,
    role,
    'aria-label': ariaLabel,
  }: any) => (
    <button
      type="button"
      role={role}
      aria-label={ariaLabel}
      disabled={disabled || loading}
      data-loading={loading ? 'true' : undefined}
      onClick={onClick}
    >
      {children}
    </button>
  ),
  Popover: ({ children, content, onOpenChange, open }: any) => (
    <div>
      <span data-testid="popover-trigger" onClick={() => onOpenChange(!open)}>
        {children}
      </span>
      {open ? content : null}
    </div>
  ),
  Spin: () => <span role="status" data-testid="loading-spinner" />,
  Typography: {
    Text: ({ children }: any) => <span>{children}</span>,
  },
}));

function namespace(id: string, name: string, sortOrder: number): MemoryNamespace {
  return {
    id,
    name,
    sortOrder,
    scope: 'global',
  };
}

function savedItem(indexStatus: string): MemoryItem {
  return {
    id: 'item-1',
    namespaceId: 'namespace-1',
    title: 'Saved text',
    content: 'Saved text',
    source: 'manual',
    indexStatus,
    updatedAt: '2026-08-20T00:00:00Z',
  };
}

function renderPopover(content = 'Remember this', disabled = false) {
  return render(
    <SaveToMemoryPopover content={content} disabled={disabled}>
      <button type="button">open memory</button>
    </SaveToMemoryPopover>,
  );
}

function openPopover() {
  fireEvent.click(screen.getByText('open memory'));
}

describe('SaveToMemoryPopover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.memoryState.namespaces = [];
    mocks.memoryState.namespacesMeta = {
      status: 'ready',
      key: 'memory-namespaces',
      loadedAt: 1,
      revision: 0,
    };
    mocks.memoryState.error = null;
    mocks.ensureNamespacesLoaded.mockResolvedValue(undefined);
    mocks.loadNamespaces.mockResolvedValue(undefined);
    mocks.saveText.mockResolvedValue(savedItem('indexing'));
  });

  it('snapshots content and loads namespaces only when a valid trigger opens', () => {
    mocks.memoryState.namespacesMeta.status = 'idle';
    mocks.ensureNamespacesLoaded.mockImplementation(async () => {
      mocks.memoryState.namespacesMeta = {
        ...mocks.memoryState.namespacesMeta,
        status: 'loading',
      };
    });

    renderPopover();
    openPopover();

    expect(mocks.ensureNamespacesLoaded).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
  });

  it('does not open or load for disabled and blank content', () => {
    const disabledView = renderPopover('Remember this', true);
    openPopover();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(mocks.ensureNamespacesLoaded).not.toHaveBeenCalled();

    disabledView.unmount();
    renderPopover('   ');
    openPopover();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(mocks.ensureNamespacesLoaded).not.toHaveBeenCalled();
  });

  it('sorts namespaces by sortOrder and renders their icons', () => {
    mocks.memoryState.namespaces = [
      namespace('last', 'Last', 20),
      namespace('first', 'First', 1),
      namespace('middle', 'Middle', 10),
    ];

    renderPopover();
    openPopover();

    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'First',
      'Middle',
      'Last',
    ]);
    expect(screen.getByTestId('namespace-icon-first')).toBeInTheDocument();
  });

  it('shows the empty state and navigates to memory management', () => {
    renderPopover();
    openPopover();

    expect(screen.getByText('chat.memory.empty')).toBeInTheDocument();
    fireEvent.click(screen.getByText('chat.memory.manage'));

    expect(mocks.setActivePage).toHaveBeenCalledWith('memory');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('shows a namespace load error and retries through loadNamespaces', () => {
    mocks.memoryState.namespacesMeta.status = 'error';
    mocks.memoryState.error = 'offline';

    renderPopover();
    openPopover();

    expect(screen.getByText('load failed: offline')).toBeInTheDocument();
    fireEvent.click(screen.getByText('chat.memory.retry'));
    expect(mocks.loadNamespaces).toHaveBeenCalledTimes(1);
  });

  it('saves the trimmed opening snapshot even if the content prop changes', async () => {
    mocks.memoryState.namespaces = [namespace('namespace-1', 'Personal', 0)];
    const view = renderPopover('  original selection  ');
    openPopover();

    view.rerender(
      <SaveToMemoryPopover content="changed selection">
        <button type="button">open memory</button>
      </SaveToMemoryPopover>,
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Personal' }));

    await waitFor(() => {
      expect(mocks.saveText).toHaveBeenCalledWith('namespace-1', 'original selection');
    });
  });

  it('prevents duplicate saves while a request is pending', async () => {
    mocks.memoryState.namespaces = [namespace('namespace-1', 'Personal', 0)];
    let resolveSave!: (item: MemoryItem) => void;
    mocks.saveText.mockReturnValue(new Promise<MemoryItem>((resolve) => {
      resolveSave = resolve;
    }));

    renderPopover();
    openPopover();
    const item = screen.getByRole('menuitem', { name: 'Personal' });
    fireEvent.click(item);
    fireEvent.click(item);

    expect(mocks.saveText).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSave(savedItem('indexing'));
    });
  });

  it.each(['indexing', 'ready'])('shows success and closes for %s saves', async (indexStatus) => {
    mocks.memoryState.namespaces = [namespace('namespace-1', 'Personal', 0)];
    mocks.saveText.mockResolvedValue(savedItem(indexStatus));

    renderPopover();
    openPopover();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Personal' }));

    await waitFor(() => {
      expect(mocks.message.success).toHaveBeenCalledWith('saved: Personal');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });

  it('shows a warning and closes when indexing is skipped', async () => {
    mocks.memoryState.namespaces = [namespace('namespace-1', 'Personal', 0)];
    mocks.saveText.mockResolvedValue(savedItem('skipped'));

    renderPopover();
    openPopover();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Personal' }));

    await waitFor(() => {
      expect(mocks.message.warning).toHaveBeenCalledWith('skipped: Personal');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });

  it('reports save failures and keeps the popover open', async () => {
    mocks.memoryState.namespaces = [namespace('namespace-1', 'Personal', 0)];
    mocks.saveText.mockRejectedValue(new Error('disk full'));

    renderPopover();
    openPopover();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Personal' }));

    await waitFor(() => {
      expect(mocks.message.error).toHaveBeenCalledWith('save failed: Error: disk full');
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });
  });
});
