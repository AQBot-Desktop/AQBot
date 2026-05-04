import { App } from 'antd';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { ProviderConfig } from '@/types';
import { ProviderList } from '../ProviderList';

const mocks = vi.hoisted(() => ({
  createProvider: vi.fn(),
  toggleProvider: vi.fn(),
  reorderProviders: vi.fn(),
  setSelectedProviderId: vi.fn(),
}));

function makeProvider(overrides: Partial<ProviderConfig>): ProviderConfig {
  return {
    id: 'provider-1',
    name: 'OpenAI',
    provider_type: 'openai',
    api_host: 'https://api.openai.com',
    api_path: null,
    enabled: true,
    models: [],
    keys: [],
    proxy_config: null,
    custom_headers: null,
    icon: null,
    builtin_id: null,
    sort_order: 0,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

let providers: ProviderConfig[] = [];
let selectedProviderId: string | null = null;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) =>
      key === 'settings.builtinProviderBadge' ? 'Built-in Label' : (fallback ?? key),
  }),
}));

vi.mock('@/lib/providerIcons', () => ({
  SmartProviderIcon: () => <span data-testid="provider-icon" />,
}));

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  closestCenter: vi.fn(),
  PointerSensor: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
}));

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: {},
  useSortable: vi.fn(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  })),
}));

vi.mock('@dnd-kit/utilities', () => ({
  CSS: {
    Transform: {
      toString: vi.fn(() => ''),
    },
  },
}));

vi.mock('@/stores', () => ({
  useProviderStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      providers,
      createProvider: mocks.createProvider,
      toggleProvider: mocks.toggleProvider,
      reorderProviders: mocks.reorderProviders,
    }),
  useUIStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      selectedProviderId,
      setSelectedProviderId: mocks.setSelectedProviderId,
    }),
}));

describe('ProviderList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectedProviderId = 'builtin-openai';
    providers = [
      makeProvider({ id: 'builtin-openai', name: 'OpenAI', builtin_id: 'openai' }),
      makeProvider({ id: 'custom-openai', name: 'Custom OpenAI', builtin_id: null }),
    ];
  });

  it('shows the built-in badge only next to built-in providers', () => {
    render(
      <App>
        <ProviderList />
      </App>,
    );

    expect(screen.getByLabelText('Built-in Label')).toBeInTheDocument();
    expect(screen.getByText('OpenAI')).toBeInTheDocument();
    expect(screen.getByText('Custom OpenAI')).toBeInTheDocument();
    expect(screen.getAllByTestId('provider-icon')).toHaveLength(2);
  });
});
