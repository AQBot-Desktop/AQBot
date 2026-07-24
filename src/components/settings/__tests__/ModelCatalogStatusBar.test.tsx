import type React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ModelCatalogStatus } from '@/types';
import { ModelCatalogStatusBar } from '../ModelCatalogStatusBar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'settings.modelCatalogMatched': 'Matched',
      'settings.modelCatalogCheckedAt': 'Checked',
      'settings.modelCatalogSource.builtin': 'Built-in',
      'settings.modelCatalogSource.network': 'Online',
      'settings.modelCatalogSource.cache': 'Online cache',
      'settings.modelCatalogSource.unavailable': 'Unavailable',
      'settings.modelCatalogBuiltinFallback': 'Built-in (online fallback)',
      'settings.modelCatalogStale': 'Stale',
      'settings.modelCatalogWarning': 'Refresh failed',
    })[key] ?? key,
  }),
}));

vi.mock('antd', () => ({
  Space: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Tag: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Tooltip: ({
    children,
    title,
  }: {
    children?: React.ReactNode;
    title?: React.ReactNode;
  }) => (
    <span>
      {children}
      <span data-testid="tooltip">{title}</span>
    </span>
  ),
  Typography: {
    Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  },
}));

function status(overrides: Partial<ModelCatalogStatus>): ModelCatalogStatus {
  return {
    configured_source: 'builtin',
    source: 'builtin',
    freshness: 'unknown',
    matched_context_windows: 12,
    total_chat_models: 20,
    checked_at: null,
    warning: null,
    ...overrides,
  };
}

describe('ModelCatalogStatusBar', () => {
  it.each([
    [status({}), 'Built-in'],
    [status({ configured_source: 'online', source: 'network', freshness: 'fresh' }), 'Online'],
    [status({ configured_source: 'online', source: 'cache', freshness: 'fresh' }), 'Online cache'],
  ])('renders the effective catalog source', (catalog, label) => {
    render(<ModelCatalogStatusBar status={catalog} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('shows stale online cache as a weak status with diagnostics in the tooltip', () => {
    render(<ModelCatalogStatusBar status={status({
      configured_source: 'online',
      source: 'cache',
      freshness: 'stale',
      warning: 'network unavailable',
    })} />);

    expect(screen.getByText('Online cache')).toBeInTheDocument();
    expect(screen.getByText('Stale')).toBeInTheDocument();
    expect(screen.getByTestId('tooltip')).toHaveTextContent('network unavailable');
    expect(screen.queryByText('Refresh failed')).not.toBeInTheDocument();
  });

  it('labels an online failure that falls back to the built-in snapshot', () => {
    render(<ModelCatalogStatusBar status={status({
      configured_source: 'online',
      warning: 'network unavailable',
    })} />);

    expect(screen.getByText('Built-in (online fallback)')).toBeInTheDocument();
    expect(screen.getByTestId('tooltip')).toHaveTextContent('network unavailable');
    expect(screen.queryByText('Refresh failed')).not.toBeInTheDocument();
  });

  it('keeps a visible error only when no catalog source is available', () => {
    render(<ModelCatalogStatusBar status={status({
      configured_source: 'online',
      source: 'unavailable',
      warning: 'both sources invalid',
    })} />);

    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByText('Refresh failed')).toBeInTheDocument();
  });
});
