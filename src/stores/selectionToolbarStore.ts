import { create } from 'zustand';
import { invoke, listen, type UnlistenFn } from '@/lib/invoke';
import type {
  SelectionToolbarHistoryItem,
  SelectionToolbarRunEvent,
  SelectionToolbarRunView,
  SelectionToolbarRuntimeStatus,
  SelectionToolbarSessionView,
  SelectionToolbarSnapshot,
  SelectionToolbarToolView,
  SelectionToolbarOverflowDirection,
} from '@/types';

const EMPTY_RUNTIME: SelectionToolbarRuntimeStatus = {
  state: 'disabled',
  platform: 'unsupported',
  permission: 'unknown',
  last_error: null,
  global_dismissal_supported: false,
};

let initialization: Promise<void> | null = null;
let unlisteners: UnlistenFn[] = [];
let eventRevision = 0;
let copyCloseTimer: number | null = null;

function cancelCopyCloseTimer() {
  if (copyCloseTimer !== null) {
    window.clearTimeout(copyCloseTimer);
    copyCloseTimer = null;
  }
}

function waitForOverflowLayout(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

export interface SelectionToolbarTranslateOptions {
  sourceLanguage?: string | null;
  targetLanguage?: string | null;
}

interface SelectionToolbarState {
  runtime: SelectionToolbarRuntimeStatus;
  session: SelectionToolbarSessionView | null;
  history: SelectionToolbarHistoryItem[];
  run: SelectionToolbarRunView | null;
  surface: 'toolbar' | 'overflow' | 'result';
  overflowDirection: SelectionToolbarOverflowDirection;
  copied: boolean;
  busy: boolean;
  error: string | null;
  /** Translate panel source language; 'auto' means auto-detect. */
  translateSource: string;
  /** Translate panel target language; null falls back to the configured/app language. */
  translateTarget: string | null;
  initialize: () => Promise<void>;
  executeTool: (
    tool: SelectionToolbarToolView,
    options?: SelectionToolbarTranslateOptions,
  ) => Promise<void>;
  setTranslateLanguages: (source: string, target: string) => Promise<void>;
  followUp: (text: string) => Promise<boolean>;
  stop: () => Promise<void>;
  copyResult: () => Promise<void>;
  regenerate: () => Promise<void>;
  setPinned: (pinned: boolean) => Promise<void>;
  dragEnded: () => Promise<void>;
  close: (reason: string) => Promise<void>;
  toggleOverflow: (overflowHeight?: number) => Promise<void>;
  dispose: () => void;
}

function isTranslateTool(tool: SelectionToolbarToolView): boolean {
  return tool.kind === 'ai' && tool.builtin_key === 'translate';
}

function historyItemFromRun(run: SelectionToolbarRunView | null): SelectionToolbarHistoryItem | null {
  if (!run || run.status === 'started' || run.status === 'streaming') return null;
  return {
    request_id: run.request_id,
    mode: run.mode,
    user_input: run.user_input,
    status: run.status,
    output: run.output,
    error: run.error,
  };
}

function historyBeforeCurrent(
  history: SelectionToolbarHistoryItem[],
  run: SelectionToolbarRunView | null,
): SelectionToolbarHistoryItem[] {
  if (!run) return history;
  const currentIndex = history.findIndex((item) => item.request_id === run.request_id);
  if (currentIndex >= 0) {
    return history.filter((_, index) => index !== currentIndex);
  }
  return history;
}

function startRun(
  state: SelectionToolbarState,
  event: Extract<SelectionToolbarRunEvent, { kind: 'started' }>,
): Partial<SelectionToolbarState> {
  let history = event.mode === 'new_tool' ? [] : state.history;
  if (event.mode === 'follow_up') {
    const previous = historyItemFromRun(state.run);
    if (previous && !history.some((item) => item.request_id === previous.request_id)) {
      history = [...history, previous];
    }
  }
  return {
    history,
    run: {
      request_id: event.request_id,
      selection_id: event.selection_id,
      tool_id: event.tool_id,
      mode: event.mode,
      user_input: event.user_input,
      status: 'started',
      output: '',
      error: null,
    },
    surface: 'result',
    copied: false,
    error: null,
  };
}

function applyRunEvent(
  state: SelectionToolbarState,
  event: SelectionToolbarRunEvent,
): Partial<SelectionToolbarState> {
  if (state.session?.selection_id !== event.selection_id) return {};
  if (event.kind === 'started') {
    return startRun(state, event);
  }
  if (!state.run || state.run.request_id !== event.request_id) return {};
  if (event.kind === 'delta') {
    return {
      run: {
        ...state.run,
        status: 'streaming',
        output: state.run.output + event.delta,
      },
    };
  }
  if (event.kind === 'error') {
    return {
      run: { ...state.run, status: 'error', error: event.error },
      error: event.error,
    };
  }
  return {
    run: {
      ...state.run,
      status: event.kind === 'completed' ? 'completed' : 'stopped',
      // Terminal events may carry the think-tag-finalized output.
      output: event.output ?? state.run.output,
    },
  };
}

export const useSelectionToolbarStore = create<SelectionToolbarState>((set, get) => ({
  runtime: EMPTY_RUNTIME,
  session: null,
  history: [],
  run: null,
  surface: 'toolbar',
  overflowDirection: 'below',
  copied: false,
  busy: false,
  error: null,
  translateSource: 'auto',
  translateTarget: null,

  initialize: async () => {
    if (initialization) return initialization;
    initialization = (async () => {
      unlisteners = await Promise.all([
        listen<SelectionToolbarSessionView>('selection-toolbar://session', ({ payload }) => {
          eventRevision += 1;
          document.documentElement.dataset.theme = payload.theme;
          document.documentElement.lang = payload.language;
          set((state) =>
            state.session?.selection_id === payload.selection_id
              ? { session: payload, busy: false }
              : {
                  session: payload,
                  history: [],
                  run: null,
                  surface: 'toolbar',
                  overflowDirection: 'below',
                  copied: false,
                  busy: false,
                  error: null,
                  translateSource: 'auto',
                  translateTarget: null,
                },
          );
        }),
        listen<string>('selection-toolbar://hidden', () => {
          eventRevision += 1;
          cancelCopyCloseTimer();
          set({
            session: null,
            history: [],
            run: null,
            surface: 'toolbar',
            overflowDirection: 'below',
            copied: false,
            busy: false,
            error: null,
            translateSource: 'auto',
            translateTarget: null,
          });
        }),
        listen<SelectionToolbarRunEvent>('selection-toolbar://run', ({ payload }) => {
          eventRevision += 1;
          set((state) => applyRunEvent(state, payload));
        }),
      ]);
      const revisionBeforeSnapshot = eventRevision;
      const snapshot = await invoke<SelectionToolbarSnapshot>('selection_toolbar_get_snapshot');
      if (eventRevision === revisionBeforeSnapshot) {
        set({
          runtime: snapshot.runtime,
          session: snapshot.session,
          history: historyBeforeCurrent(snapshot.history ?? [], snapshot.run),
          run: snapshot.run,
          surface: snapshot.run ? 'result' : 'toolbar',
          overflowDirection: 'below',
          busy: false,
          error: snapshot.run?.error ?? null,
        });
      } else {
        set({ runtime: snapshot.runtime });
      }
      // Tell the backend listeners are live so any pending session is flushed.
      try {
        await invoke('selection_toolbar_frontend_ready');
      } catch {
        // Non-fatal in browser mock / partial capability.
      }
    })().catch((error) => {
      initialization = null;
      set({ error: String(error), busy: false });
      throw error;
    });
    return initialization;
  },

  executeTool: async (tool, options) => {
    if (get().busy) return;
    const session = get().session;
    if (!session) {
      set({ error: 'Selection is no longer active' });
      return;
    }
    // Running another tool must cancel a pending copy-close so the result
    // panel is not torn down ~700ms later.
    cancelCopyCloseTimer();
    set({ busy: true, error: null });
    try {
      if (tool.kind === 'action') {
        if (tool.builtin_key === 'search') {
          await invoke('selection_toolbar_search_selection', {
            selectionId: session.selection_id,
          });
          set({ busy: false });
          copyCloseTimer = window.setTimeout(() => {
            copyCloseTimer = null;
            if (!get().run) {
              void get().close('search_completed');
            }
          }, 400);
          return;
        }
        await invoke('selection_toolbar_copy_selection', {
          selectionId: session.selection_id,
        });
        set({ copied: true, busy: false });
        copyCloseTimer = window.setTimeout(() => {
          copyCloseTimer = null;
          // Only auto-close if no AI run took over in the meantime.
          if (!get().run) {
            void get().close('copy_completed');
          }
        }, 700);
        return;
      }
      // The translate tool always runs with the panel's language choices so
      // re-clicks and regenerate keep the user's selection.
      const effective = options
        ?? (isTranslateTool(tool)
          ? {
              sourceLanguage: get().translateSource,
              targetLanguage: get().translateTarget,
            }
          : undefined);
      const requestId = await invoke<string>('selection_toolbar_execute_tool', {
        selectionId: session.selection_id,
        toolId: tool.id,
        options: effective
          ? {
              source_language: effective.sourceLanguage ?? null,
              target_language: effective.targetLanguage ?? null,
            }
          : null,
      });
      if (!get().run || get().run?.request_id !== requestId) {
        set((state) => startRun(state, {
          kind: 'started',
          request_id: requestId,
          selection_id: session.selection_id,
          tool_id: tool.id,
          mode: 'new_tool',
          user_input: null,
        }));
      }
      set({ busy: false });
    } catch (error) {
      const message = String(error);
      set({
        run: {
          request_id: `frontend-error-${Date.now()}`,
          selection_id: session.selection_id,
          tool_id: tool.id,
          mode: 'new_tool',
          user_input: null,
          status: 'error',
          output: '',
          error: message,
        },
        surface: 'result',
        history: [],
        error: message,
        busy: false,
      });
      try {
        await invoke('selection_toolbar_set_surface', { surface: 'result' });
      } catch (surfaceError) {
        const combined = `${message}\n${String(surfaceError)}`;
        set((state) => ({
          error: combined,
          run: state.run ? { ...state.run, error: combined } : state.run,
        }));
      }
    }
  },

  setTranslateLanguages: async (source, target) => {
    const previousTarget = get().translateTarget;
    set({ translateSource: source, translateTarget: target });
    if (target !== previousTarget) {
      // Persist so future sessions open with the chosen target; a failure only
      // affects the default of later sessions, not this run.
      void invoke('selection_toolbar_set_translate_target', { language: target }).catch(
        (error) => {
          console.warn('Failed to persist translate target language:', error);
        },
      );
    }
    const tool = get().session?.tools.find(isTranslateTool);
    if (!tool) return;
    await get().executeTool(tool, { sourceLanguage: source, targetLanguage: target });
  },

  followUp: async (text) => {
    const question = text.trim();
    const { busy, run, session } = get();
    if (!question || !session || !run || busy) return false;
    const canFollowUp = (run.status === 'completed' || run.status === 'stopped')
      && run.output.trim().length > 0;
    if (!canFollowUp) return false;
    set({ busy: true, error: null });
    try {
      const requestId = await invoke<string>('selection_toolbar_follow_up', {
        selectionId: session.selection_id,
        text: question,
      });
      if (!get().run || get().run?.request_id !== requestId) {
        set((state) => startRun(state, {
          kind: 'started',
          request_id: requestId,
          selection_id: session.selection_id,
          tool_id: run.tool_id,
          mode: 'follow_up',
          user_input: question,
        }));
      }
      set({ busy: false });
      return true;
    } catch (error) {
      set({ error: String(error), busy: false });
      return false;
    }
  },

  stop: async () => {
    const run = get().run;
    if (!run) return;
    await invoke('selection_toolbar_stop_generation', { requestId: run.request_id });
  },

  copyResult: async () => {
    const run = get().run;
    if (!run) return;
    await invoke('selection_toolbar_copy_result', { requestId: run.request_id });
    set({ copied: true });
    window.setTimeout(() => set({ copied: false }), 700);
  },

  regenerate: async () => {
    const { run, session, busy } = get();
    if (!run || !session || busy) return;
    if (run.status === 'started' || run.status === 'streaming') return;
    set({ busy: true, error: null });
    try {
      const requestId = await invoke<string>('selection_toolbar_regenerate', {
        selectionId: session.selection_id,
        requestId: run.request_id,
      });
      if (!get().run || get().run?.request_id !== requestId) {
        set((state) => startRun(state, {
          kind: 'started',
          request_id: requestId,
          selection_id: session.selection_id,
          tool_id: run.tool_id,
          mode: 'regenerate',
          user_input: run.user_input,
        }));
      }
      set({ busy: false });
    } catch (error) {
      set({ error: String(error), busy: false });
    }
  },

  setPinned: async (pinned) => {
    const session = get().session;
    if (!session || session.pinned === pinned) return;
    try {
      const effectivePinned = await invoke<boolean>('selection_toolbar_set_pinned', {
        selectionId: session.selection_id,
        pinned,
      });
      set((state) => state.session?.selection_id === session.selection_id
        ? { session: { ...state.session, pinned: effectivePinned }, error: null }
        : {});
    } catch (error) {
      set({ error: String(error) });
    }
  },

  dragEnded: async () => {
    const session = get().session;
    if (!session) return;
    try {
      await invoke('selection_toolbar_drag_ended', { selectionId: session.selection_id });
    } catch (error) {
      set({ error: String(error) });
    }
  },

  close: async (reason) => {
    cancelCopyCloseTimer();
    await invoke('selection_toolbar_close', { reason });
    set({
      session: null,
      history: [],
      run: null,
      surface: 'toolbar',
      overflowDirection: 'below',
      copied: false,
      busy: false,
      error: null,
      translateSource: 'auto',
      translateTarget: null,
    });
  },

  toggleOverflow: async (overflowHeight) => {
    if (get().busy) return;
    const opening = get().surface !== 'overflow';
    if (!opening) {
      await invoke('selection_toolbar_set_surface', {
        surface: 'toolbar',
        overflowHeight: null,
      });
      set({ surface: 'toolbar', overflowDirection: 'below' });
      return;
    }

    const measuredHeight = overflowHeight ?? 214;
    const preparedDirection = await invoke<SelectionToolbarOverflowDirection>(
      'selection_toolbar_prepare_overflow',
      { overflowHeight: measuredHeight },
    );
    set({ surface: 'overflow', overflowDirection: preparedDirection });
    await waitForOverflowLayout();

    try {
      const appliedDirection = await invoke<SelectionToolbarOverflowDirection | null>(
        'selection_toolbar_set_surface',
        {
          surface: 'overflow',
          overflowHeight: measuredHeight,
        },
      );
      if (appliedDirection && appliedDirection !== preparedDirection) {
        set({ overflowDirection: appliedDirection });
      }
    } catch (error) {
      set({ surface: 'toolbar', overflowDirection: 'below' });
      throw error;
    }
  },

  dispose: () => {
    unlisteners.forEach((unlisten) => unlisten());
    unlisteners = [];
    eventRevision = 0;
    initialization = null;
  },
}));
