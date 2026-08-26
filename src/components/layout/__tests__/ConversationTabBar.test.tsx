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

function mockScrollerLayout(
  scroller: HTMLDivElement,
  layout: {
    clientWidth: number;
    scrollWidth: number;
    tabs: Array<{ id: string; left: number; width: number }>;
  },
) {
  Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: layout.clientWidth });
  Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: layout.scrollWidth });
  scroller.scrollBy = vi.fn();
  scroller.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: layout.clientWidth,
    bottom: 36,
    width: layout.clientWidth,
    height: 36,
    toJSON() { return {}; },
  });
  for (const tab of layout.tabs) {
    const element = scroller.querySelector<HTMLElement>(`[data-conversation-tab="${tab.id}"]`);
    if (!element) continue;
    element.scrollIntoView = vi.fn();
    element.getBoundingClientRect = () => ({
      x: tab.left,
      y: 0,
      top: 0,
      left: tab.left,
      right: tab.left + tab.width,
      bottom: 26,
      width: tab.width,
      height: 26,
      toJSON() { return {}; },
    });
  }
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

  it('keeps a gap between the tab strip and the title-bar edges', () => {
    const { container } = renderBar();
    expect(container.querySelector('.conversation-tab-bar')).toHaveStyle({
      paddingLeft: '8px',
      paddingRight: '8px',
    });
  });

  it('requests a new conversation from the plus button without marking the strip as undraggable', () => {
    const onNew = vi.fn();
    window.addEventListener('aqbot:new-conversation', onNew);
    const { container } = renderBar();
    const plus = screen.getByRole('button', { name: 'titlebar.newConversation' });
    fireEvent.click(plus);
    expect(onNew).toHaveBeenCalledTimes(1);
    window.removeEventListener('aqbot:new-conversation', onNew);

    expect(container.querySelector('.conversation-tab-bar')).not.toHaveClass('title-bar-nodrag');
    expect(plus).toHaveClass('title-bar-nodrag');
    expect(screen.getByRole('tab', { name: /Alpha chat/ })).toHaveClass('title-bar-nodrag');
  });

  it('does not show a right-overflow badge when the tab strip fits', () => {
    const { container } = renderBar();
    const scroller = container.querySelector('.conversation-tab-scroller') as HTMLDivElement;
    mockScrollerLayout(scroller, {
      clientWidth: 400,
      scrollWidth: 403,
      tabs: [
        { id: 'beta', left: 0, width: 120 },
        { id: 'alpha', left: 124, width: 140 },
        { id: 'gamma', left: 268, width: 135 },
      ],
    });
    fireEvent.scroll(scroller);
    expect(screen.queryByRole('button', { name: /titlebar.hiddenTabsRight/ })).not.toBeInTheDocument();
  });

  it('activates an overflow tab from the hidden-tabs menu', async () => {
    const { container } = renderBar();
    const scroller = container.querySelector('.conversation-tab-scroller') as HTMLDivElement;
    mockScrollerLayout(scroller, {
      clientWidth: 150,
      scrollWidth: 400,
      tabs: [
        { id: 'beta', left: 0, width: 80 },
        { id: 'alpha', left: 84, width: 80 },
        { id: 'gamma', left: 300, width: 80 },
      ],
    });
    fireEvent.scroll(scroller);

    fireEvent.mouseEnter(await screen.findByRole('button', { name: /titlebar.hiddenTabsRight/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Gamma chat/ }));
    expect(useConversationStore.getState().setActiveConversation).toHaveBeenCalledWith('gamma');
  });

  it('keeps the plus button when no conversation tabs are open', () => {
    useConversationTabsStore.setState({
      ...EMPTY_CONVERSATION_TABS,
      hasAttemptedRestore: false,
    });
    useConversationStore.setState({
      conversations: [],
      activeConversationId: null,
    } as any);
    renderBar();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'titlebar.newConversation' })).toBeInTheDocument();
  });
});
