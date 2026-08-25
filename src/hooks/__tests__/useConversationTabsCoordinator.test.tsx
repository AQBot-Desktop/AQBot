import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConversation } from '@/stores/__tests__/conversationStore.testUtils';
import { useConversationStore } from '@/stores/conversationStore';
import { useConversationTabsStore } from '@/stores/conversationTabsStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { EMPTY_CONVERSATION_TABS } from '@/lib/conversationTabs';
import { useConversationTabsCoordinator } from '../useConversationTabsCoordinator';

function Harness({ enabled = true }: { enabled?: boolean }) {
  useConversationTabsCoordinator(enabled);
  return null;
}

describe('useConversationTabsCoordinator', () => {
  beforeEach(() => {
    useConversationTabsStore.setState({
      ...EMPTY_CONVERSATION_TABS,
      hasAttemptedRestore: false,
    });
    useSettingsStore.setState({
      loading: false,
      settings: {
        ...useSettingsStore.getState().settings,
        last_selected_conversation_id: 'kept',
      },
      saveSettings: vi.fn(),
    } as any);
    useConversationStore.setState({
      conversations: [
        makeConversation('kept', { title: 'Kept', updated_at: 2 }),
        makeConversation('other', { title: 'Other', updated_at: 1 }),
      ],
      conversationsMeta: { status: 'ready', key: 'conversations', loadedAt: 1, revision: 1 },
      activeConversationId: null,
      setActiveConversation: vi.fn((id: string | null) => {
        useConversationStore.setState({ activeConversationId: id });
      }),
    } as any);
  });

  afterEach(() => {
    useConversationTabsStore.setState({
      ...EMPTY_CONVERSATION_TABS,
      hasAttemptedRestore: false,
    });
  });

  it('restores the last selected conversation once conversations are ready', () => {
    render(<Harness />);
    expect(useConversationStore.getState().setActiveConversation).toHaveBeenCalledWith('kept');
    expect(useConversationTabsStore.getState().openIds).toContain('kept');
  });

  it('does not reopen a conversation after the last tab is closed', () => {
    useConversationTabsStore.setState({
      ...EMPTY_CONVERSATION_TABS,
      suppressAutoSelect: true,
      hasAttemptedRestore: true,
    });
    render(<Harness />);
    expect(useConversationStore.getState().setActiveConversation).not.toHaveBeenCalled();
    expect(useConversationStore.getState().activeConversationId).toBeNull();
  });

  it('does not manage tabs in an independent conversation window', () => {
    render(<Harness enabled={false} />);
    expect(useConversationStore.getState().setActiveConversation).not.toHaveBeenCalled();
    expect(useConversationTabsStore.getState().openIds).toEqual([]);
  });
});
