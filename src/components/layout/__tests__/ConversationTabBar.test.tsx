import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConversation } from '@/stores/__tests__/conversationStore.testUtils';
import { useConversationStore } from '@/stores/conversationStore';
import { useConversationTabsStore } from '@/stores/conversationTabsStore';
import { EMPTY_CONVERSATION_TABS } from '@/lib/conversationTabs';
import { ConversationTabBar } from '../ConversationTabBar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en-US', dir: () => 'ltr' },
  }),
}));

vi.mock('@lobehub/icons', () => ({
  ModelIcon: () => <span data-testid="model-icon" />,
  modelMappings: [],
}));

vi.mock('@/hooks/useResolvedAvatarSrc', () => ({
  useResolvedAvatarSrc: () => null,
}));

vi.mock('@/lib/convIcon', () => ({
  getConvIcon: () => null,
}));

vi.mock('@/lib/conversationTabsActions', () => ({
  closeConversationTab: vi.fn(),
  closeConversationTabs: vi.fn(),
}));

function renderBar() {
  return render(
    <App>
      <ConversationTabBar />
    </App>,
  );
}

describe('ConversationTabBar', () => {
  beforeEach(() => {
    useConversationTabsStore.setState({
      ...EMPTY_CONVERSATION_TABS,
      hasAttemptedRestore: false,
    });
    useConversationStore.setState({
      conversations: [
        makeConversation('alpha', { title: 'Alpha chat' }),
        makeConversation('beta', { title: 'Beta chat', tab_pin_order: 1 }),
        makeConversation('gamma', { title: 'Gamma chat' }),
      ],
      activeConversationId: 'alpha',
      streamingConversationId: null,
      setActiveConversation: vi.fn((id: string | null) => {
        useConversationStore.setState({ activeConversationId: id });
      }),
      setConversationTabPinned: vi.fn(),
    } as any);
    useConversationTabsStore.getState().remember('alpha');
    useConversationTabsStore.getState().remember('gamma');
  });

  afterEach(() => {
    cleanup();
  });

  it('renders pinned tabs first and keeps the active tab selected', () => {
    renderBar();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      expect.stringContaining('Beta chat'),
      expect.stringContaining('Alpha chat'),
      expect.stringContaining('Gamma chat'),
    ]);
    expect(screen.getByRole('tab', { name: /Alpha chat/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('activates a tab on click and supports keyboard movement', () => {
    renderBar();
    fireEvent.click(screen.getByRole('tab', { name: /Gamma chat/ }));
    expect(useConversationStore.getState().setActiveConversation).toHaveBeenCalledWith('gamma');

    const alpha = screen.getByRole('tab', { name: /Alpha chat/ });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /Gamma chat/ }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Enter' });
    expect(useConversationStore.getState().setActiveConversation).toHaveBeenCalledWith('gamma');
  });

  it('closes a tab from the close button without deleting the conversation', async () => {
    const { closeConversationTab } = await import('@/lib/conversationTabsActions');
    renderBar();
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: /Alpha chat/ }).querySelector('button')!);
    });
    expect(closeConversationTab).toHaveBeenCalledWith('alpha');
    expect(useConversationStore.getState().conversations.map((item) => item.id)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  it('offers close-others actions in the tab context menu', async () => {
    const { closeConversationTabs } = await import('@/lib/conversationTabsActions');
    renderBar();
    fireEvent.contextMenu(screen.getByRole('tab', { name: /Alpha chat/ }));
    expect(await screen.findByText('titlebar.closeOtherTabs')).toBeInTheDocument();
    expect(screen.getByText('titlebar.closeOtherUnpinnedTabs')).toBeInTheDocument();
    expect(screen.getByText('titlebar.closeTabsToTheLeft')).toBeInTheDocument();
    expect(screen.getByText('titlebar.closeTabsToTheRight')).toBeInTheDocument();
    fireEvent.click(screen.getByText('titlebar.closeOtherUnpinnedTabs'));
    expect(closeConversationTabs).toHaveBeenCalledWith(['gamma']);
  });

  it('converts vertical mouse wheel movement into horizontal tab scrolling', () => {
    const { container } = renderBar();
    const scroller = container.querySelector('.conversation-tab-scroller') as HTMLDivElement;
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 80 });
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 400 });
    scroller.scrollLeft = 10;
    fireEvent.wheel(scroller, { deltaY: 30, deltaX: 0 });
    expect(scroller.scrollLeft).toBe(40);
  });
});
