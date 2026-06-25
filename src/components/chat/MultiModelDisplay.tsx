import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { Alert, Button, Dropdown, Popconfirm, Tag, Tooltip, Typography, theme } from 'antd';
import { ArrowLeftRight, Check, ChevronLeft, ChevronRight, Columns2, GitBranch, LayoutList, Pencil, RotateCcw, Rows3, Trash2 } from 'lucide-react';
import { ModelIcon } from '@lobehub/icons';
import { useTranslation } from 'react-i18next';
import { OverlayScrollbars } from 'overlayscrollbars';
import type { Message } from '@/types';
import { CopyButton } from '@/components/common/CopyButton';
import { stripAqbotTags } from '@/lib/chatMarkdown';
import { getMessageVersionGroupKey, selectDisplayVersionsByModel } from '@/lib/chatMultiModel';
import {
  getLiveStreamContent,
  subscribeLiveStreamContent,
  useConversationStore,
} from '@/stores';
import { ModelSelector } from './ModelSelector';

export type MultiModelDisplayMode = 'tabs' | 'side-by-side' | 'stacked';

function useLiveStreamContent(messageId: string | null | undefined, enabled: boolean): string | undefined {
  const subscribedMessageId = enabled ? messageId : null;
  return useSyncExternalStore(
    useCallback(
      (listener) => subscribeLiveStreamContent(subscribedMessageId, listener),
      [subscribedMessageId],
    ),
    useCallback(
      () => getLiveStreamContent(subscribedMessageId),
      [subscribedMessageId],
    ),
    () => undefined,
  );
}

function MultiModelVersionContent({
  message,
  isVersionStreaming,
  renderContent,
}: {
  message: Message;
  isVersionStreaming: boolean;
  renderContent: (msg: Message, isVersionStreaming: boolean) => React.ReactNode;
}) {
  const liveContent = useLiveStreamContent(message.id, isVersionStreaming);
  const renderMessage = liveContent === undefined ? message : { ...message, content: liveContent };
  return <>{renderContent(renderMessage, isVersionStreaming)}</>;
}

/** Error boundary to prevent white-screen crashes in multi-model display */
class MultiModelErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback?: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode; fallback?: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <Alert type="warning" message="Multi-model display error" showIcon />
      );
    }
    return this.props.children;
  }
}

export interface MultiModelDisplayProps {
  versions: Message[];
  activeMessageId: string;
  mode: 'side-by-side' | 'stacked';
  conversationId: string;
  onSwitchVersion: (parentMessageId: string, messageId: string) => void;
  onDeleteVersion?: (messageId: string) => void;
  onRegenerateVersion?: (message: Message) => void | Promise<void>;
  onEditVersion?: (message: Message) => void;
  onBranchVersion?: (message: Message, asChild: boolean) => void;
  onSwitchModelVersion?: (message: Message, providerId: string, modelId: string) => void | Promise<void>;
  onSetContextVersion?: (message: Message) => void;
  onDisplayVersionChange?: (parentMessageId: string, modelKey: string, messageId: string) => void;
  displayVersionIdsByModelKey?: ReadonlyMap<string, string>;
  renderContent: (msg: Message, isVersionStreaming: boolean) => React.ReactNode;
  getModelDisplayInfo: (
    modelId?: string | null,
    providerId?: string | null,
  ) => { modelName: string; providerName: string };
  streamingMessageId?: string | null;
  multiModelDoneMessageIds: string[];
}

/**
 * Renders multiple model versions side-by-side or stacked.
 * Used when multi_model_display_mode is not 'tabs'.
 */
export const MultiModelDisplay = React.memo(function MultiModelDisplay({
  versions,
  activeMessageId,
  mode,
  conversationId,
  onSwitchVersion,
  onDeleteVersion,
  onRegenerateVersion,
  onEditVersion,
  onBranchVersion,
  onSwitchModelVersion,
  onSetContextVersion,
  onDisplayVersionChange,
  displayVersionIdsByModelKey,
  renderContent,
  getModelDisplayInfo,
  streamingMessageId,
}: MultiModelDisplayProps) {
  const { token } = theme.useToken();
  const { t } = useTranslation();

  // Safety: if versions is empty or invalid, render nothing
  if (!versions || versions.length === 0) return null;

  return (
    <MultiModelErrorBoundary>
      <MultiModelDisplayInner
        versions={versions}
        activeMessageId={activeMessageId}
        mode={mode}
        conversationId={conversationId}
        onSwitchVersion={onSwitchVersion}
        onDeleteVersion={onDeleteVersion}
        onRegenerateVersion={onRegenerateVersion}
        onEditVersion={onEditVersion}
        onBranchVersion={onBranchVersion}
        onSwitchModelVersion={onSwitchModelVersion}
        onSetContextVersion={onSetContextVersion}
        onDisplayVersionChange={onDisplayVersionChange}
        displayVersionIdsByModelKey={displayVersionIdsByModelKey}
        renderContent={renderContent}
        getModelDisplayInfo={getModelDisplayInfo}
        streamingMessageId={streamingMessageId}
        token={token}
        t={t}
      />
    </MultiModelErrorBoundary>
  );
});

interface MultiModelDisplayInnerProps extends Omit<MultiModelDisplayProps, 'multiModelDoneMessageIds'> {
  token: ReturnType<typeof theme.useToken>['token'];
  t: ReturnType<typeof useTranslation>['t'];
}

function MultiModelDisplayInner({
  versions,
  activeMessageId,
  mode,
  conversationId,
  onSwitchVersion,
  onDeleteVersion,
  onRegenerateVersion,
  onEditVersion,
  onBranchVersion,
  onSwitchModelVersion,
  onSetContextVersion,
  onDisplayVersionChange,
  displayVersionIdsByModelKey,
  renderContent,
  getModelDisplayInfo,
  streamingMessageId,
  token,
  t,
}: MultiModelDisplayInnerProps) {
  const parentMessageId = versions[0]?.parent_message_id;
  const storeMessages = useConversationStore((state) => state.messages);
  const storeStreaming = useConversationStore((state) => state.streaming);
  const streamingConversationId = useConversationStore((state) => state.streamingConversationId);
  const liveVersions = useMemo(() => {
    if (!parentMessageId) return [];
    return storeMessages.filter((message) =>
      message.parent_message_id === parentMessageId && message.role === 'assistant'
    );
  }, [parentMessageId, storeMessages]);
  const renderVersions = liveVersions.length > 0 ? liveVersions : versions;
  const displayVersions = useMemo(
    () => selectDisplayVersionsByModel(renderVersions, activeMessageId, displayVersionIdsByModelKey),
    [activeMessageId, displayVersionIdsByModelKey, renderVersions],
  );
  const isDisplayStreaming = storeStreaming && streamingConversationId === conversationId;

  // For side-by-side mode, force the .ant-bubble ancestor to take full width
  const scrollRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (mode !== 'side-by-side') return;
    const el = scrollRef.current;
    if (!el) return;

    const modified: Array<{ el: HTMLElement; prev: string }> = [];
    let cur: HTMLElement | null = el;
    while (cur) {
      if (cur.classList.contains('ant-bubble')) {
        modified.push({ el: cur, prev: cur.style.cssText });
        cur.style.width = '100%';
        cur.style.boxSizing = 'border-box';
        break;
      }
      if (cur.classList.contains('ant-bubble-body') || cur.classList.contains('ant-bubble-content')) {
        modified.push({ el: cur, prev: cur.style.cssText });
        cur.style.overflow = 'hidden';
        cur.style.minWidth = '0';
        cur.style.width = '100%';
      }
      cur = cur.parentElement;
    }

    return () => {
      for (const item of modified) {
        item.el.style.cssText = item.prev;
      }
    };
  }, [mode]);

  // Initialize OverlayScrollbars for persistent horizontal scrollbar
  useEffect(() => {
    if (mode !== 'side-by-side') return;
    const el = scrollRef.current;
    if (!el) return;

    const inst = OverlayScrollbars(
      { target: el, elements: { viewport: el } },
      {
        scrollbars: {
          theme: 'os-theme-aqbot',
          autoHide: 'never',
          clickScroll: true,
        },
        overflow: { x: 'scroll', y: 'hidden' },
      },
    );

    return () => inst.destroy();
  }, [mode]);

  if (displayVersions.length <= 1) {
    const msg = displayVersions[0];
    if (!msg) return null;
    const isVersionStreaming = isDisplayStreaming && (msg.id === streamingMessageId || msg.status === 'partial');
    return (
      <MultiModelVersionContent
        message={msg}
        isVersionStreaming={isVersionStreaming}
        renderContent={renderContent}
      />
    );
  }

  const containerStyle: React.CSSProperties =
    mode === 'side-by-side'
      ? {
          display: 'flex',
          gap: 12,
          overflowX: 'auto',
          paddingBottom: 8,
          width: '100%',
          boxSizing: 'border-box',
          alignItems: 'stretch',
        }
      : {
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        };

  const cardStyle: React.CSSProperties =
    mode === 'side-by-side'
      ? {
          minWidth: 300,
          flex: '0 0 auto',
          width: `calc((100% - ${(displayVersions.length - 1) * 12}px) / ${displayVersions.length})`,
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: token.borderRadiusLG,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }
      : {
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: token.borderRadiusLG,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        };

  return (
    <div ref={scrollRef} style={containerStyle} className={mode === 'side-by-side' ? 'aqbot-multi-model-scroll' : undefined}>
      {displayVersions.map((vMsg) => {
        const isActive = vMsg.id === activeMessageId;
        const isVersionStreaming = isDisplayStreaming && (
          vMsg.id === streamingMessageId || vMsg.status === 'partial'
        );
        const { modelName, providerName } = getModelDisplayInfo(
          vMsg.model_id,
          vMsg.provider_id,
        );

        return (
          <div
            key={vMsg.id}
            data-testid={`multi-model-card-${vMsg.id}`}
            style={{
              ...cardStyle,
              borderColor: isActive ? token.colorPrimary : token.colorBorderSecondary,
            }}
          >
            {/* Card header */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 12px',
                borderBottom: `1px solid ${token.colorBorderSecondary}`,
                backgroundColor: token.colorBgLayout,
                flexShrink: 0,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <ModelIcon model={vMsg.model_id ?? ''} size={20} type="avatar" />
                {providerName && (
                  <Tag
                    style={{
                      fontSize: 11,
                      margin: 0,
                      padding: '0 4px',
                      lineHeight: '18px',
                      color: token.colorPrimary,
                      backgroundColor: token.colorPrimaryBg,
                      border: 'none',
                    }}
                  >
                    {providerName}
                  </Tag>
                )}
                <Typography.Text style={{ fontSize: 13 }}>{modelName}</Typography.Text>
                {isVersionStreaming && (
                  <span className="aqbot-streaming-dots" aria-hidden="true" style={{ marginLeft: 4 }}>
                    <span /><span /><span />
                  </span>
                )}
              </div>
              <div className="multi-model-card-header-actions" style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <MultiModelContextButton
                  message={vMsg}
                  isActive={isActive}
                  parentMessageId={parentMessageId}
                  token={token}
                  t={t}
                  onSwitchVersion={onSwitchVersion}
                  onSetContextVersion={onSetContextVersion}
                />
              </div>
            </div>
            {/* Card content — key includes mode to force re-mount on layout switch */}
            <div
              key={`content-${mode}`}
              data-testid={`multi-model-card-content-${vMsg.id}`}
              style={{
                padding: '12px',
                flex: 1,
                minHeight: 0,
              }}
            >
              <MultiModelVersionContent
                message={vMsg}
                isVersionStreaming={isVersionStreaming}
                renderContent={renderContent}
              />
            </div>
            <MultiModelCardActions
              message={vMsg}
              renderVersions={renderVersions}
              displayVersions={displayVersions}
              isVersionStreaming={isVersionStreaming}
              parentMessageId={parentMessageId}
              token={token}
              t={t}
              onDeleteVersion={onDeleteVersion}
              onRegenerateVersion={onRegenerateVersion}
              onEditVersion={onEditVersion}
              onBranchVersion={onBranchVersion}
              onSwitchModelVersion={onSwitchModelVersion}
              onDisplayVersionChange={onDisplayVersionChange}
            />
          </div>
        );
      })}
    </div>
  );
}

function MultiModelContextButton({
  message,
  isActive,
  parentMessageId,
  token,
  t,
  onSwitchVersion,
  onSetContextVersion,
}: {
  message: Message;
  isActive: boolean;
  parentMessageId?: string | null;
  token: ReturnType<typeof theme.useToken>['token'];
  t: ReturnType<typeof useTranslation>['t'];
  onSwitchVersion: (parentMessageId: string, messageId: string) => void;
  onSetContextVersion?: (message: Message) => void;
}) {
  const setContext = () => {
    if (isActive || !parentMessageId) return;
    if (onSetContextVersion) {
      onSetContextVersion(message);
      return;
    }
    onSwitchVersion(parentMessageId, message.id);
  };

  return (
    <Tooltip title={isActive ? t('chat.multiModelCurrentContext') : t('chat.multiModelUseAsContext')}>
      <button
        type="button"
        data-testid={`multi-model-set-context-${message.id}`}
        disabled={isActive || !parentMessageId}
        onClick={setContext}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          borderRadius: '50%',
          cursor: isActive ? 'default' : 'pointer',
          backgroundColor: isActive ? token.colorPrimary : 'transparent',
          color: isActive ? '#fff' : token.colorTextSecondary,
          border: isActive ? 'none' : `1px solid ${token.colorBorder}`,
          transition: 'all 0.2s',
          padding: 0,
        }}
      >
        <Check size={14} />
      </button>
    </Tooltip>
  );
}

function MultiModelCardActions({
  message,
  renderVersions,
  displayVersions,
  isVersionStreaming,
  parentMessageId,
  token,
  t,
  onDeleteVersion,
  onRegenerateVersion,
  onEditVersion,
  onBranchVersion,
  onSwitchModelVersion,
  onDisplayVersionChange,
}: {
  message: Message;
  renderVersions: Message[];
  displayVersions: Message[];
  isVersionStreaming: boolean;
  parentMessageId?: string | null;
  token: ReturnType<typeof theme.useToken>['token'];
  t: ReturnType<typeof useTranslation>['t'];
  onDeleteVersion?: (messageId: string) => void;
  onRegenerateVersion?: (message: Message) => void | Promise<void>;
  onEditVersion?: (message: Message) => void;
  onBranchVersion?: (message: Message, asChild: boolean) => void;
  onSwitchModelVersion?: (message: Message, providerId: string, modelId: string) => void | Promise<void>;
  onDisplayVersionChange?: (parentMessageId: string, modelKey: string, messageId: string) => void;
}) {
  const modelKey = getMessageVersionGroupKey(message);
  const sameModelVersions = useMemo(
    () => renderVersions
      .filter((version) => getMessageVersionGroupKey(version) === modelKey)
      .sort((left, right) =>
        left.version_index - right.version_index
        || left.created_at - right.created_at
        || left.id.localeCompare(right.id)
      ),
    [modelKey, renderVersions],
  );
  const currentVersionIndex = sameModelVersions.findIndex((version) => version.id === message.id);
  const canUseVersionPagination = Boolean(parentMessageId && sameModelVersions.length > 1 && onDisplayVersionChange);
  const actionsDisabled = isVersionStreaming || message.status === 'partial';
  const currentModelOverride = message.provider_id && message.model_id
    ? { providerId: message.provider_id, modelId: message.model_id }
    : null;

  const switchDisplayedVersion = (nextIndex: number) => {
    if (!canUseVersionPagination || !parentMessageId) return;
    const next = sameModelVersions[nextIndex];
    if (!next) return;
    onDisplayVersionChange?.(parentMessageId, modelKey, next.id);
  };

  return (
    <div
      className="multi-model-card-footer-actions"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '6px 10px',
        borderTop: `1px solid ${token.colorBorderSecondary}`,
        backgroundColor: token.colorBgContainer,
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, minWidth: 58 }}>
        {sameModelVersions.length > 1 && (
          <>
            <Button
              type="text"
              size="small"
              icon={<ChevronLeft size={14} />}
              disabled={!canUseVersionPagination || currentVersionIndex <= 0}
              data-testid={`multi-model-version-prev-${message.id}`}
              onClick={() => switchDisplayedVersion(currentVersionIndex - 1)}
              style={{ minWidth: 20, padding: '0 2px' }}
            />
            <Typography.Text style={{ fontSize: 11, color: token.colorTextSecondary }}>
              {Math.max(currentVersionIndex, 0) + 1}/{sameModelVersions.length}
            </Typography.Text>
            <Button
              type="text"
              size="small"
              icon={<ChevronRight size={14} />}
              disabled={!canUseVersionPagination || currentVersionIndex >= sameModelVersions.length - 1}
              data-testid={`multi-model-version-next-${message.id}`}
              onClick={() => switchDisplayedVersion(currentVersionIndex + 1)}
              style={{ minWidth: 20, padding: '0 2px' }}
            />
          </>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <CopyButton
          text={() => stripAqbotTags(message.content ?? '')}
          size={13}
          timeout={3000}
        />
        <Tooltip title={t('chat.regenerate')}>
          <Button
            type="text"
            size="small"
            icon={<RotateCcw size={13} />}
            disabled={actionsDisabled || !onRegenerateVersion}
            data-testid={`multi-model-regenerate-${message.id}`}
            onClick={() => onRegenerateVersion?.(message)}
          />
        </Tooltip>
        <Tooltip title={t('chat.editMessage')}>
          <Button
            type="text"
            size="small"
            icon={<Pencil size={13} />}
            disabled={actionsDisabled || !onEditVersion}
            data-testid={`multi-model-edit-${message.id}`}
            onClick={() => onEditVersion?.(message)}
          />
        </Tooltip>
        <ModelSelector
          onSelect={(providerId, modelId) => onSwitchModelVersion?.(message, providerId, modelId)}
          overrideCurrentModel={currentModelOverride}
        >
          <Tooltip title={t('chat.switchModel')}>
            <Button
              type="text"
              size="small"
              icon={<ArrowLeftRight size={13} />}
              disabled={actionsDisabled || !onSwitchModelVersion}
              data-testid={`multi-model-switch-model-${message.id}`}
            />
          </Tooltip>
        </ModelSelector>
        <Dropdown
          disabled={actionsDisabled || !onBranchVersion}
          menu={{
            items: [
              {
                key: 'independent',
                label: t('chat.branchIndependent'),
                onClick: () => onBranchVersion?.(message, false),
              },
              {
                key: 'child',
                label: t('chat.branchChild'),
                onClick: () => onBranchVersion?.(message, true),
              },
            ],
          }}
          trigger={['click']}
          placement="bottom"
        >
          <Tooltip title={t('chat.branchConversation')}>
            <Button
              type="text"
              size="small"
              icon={<GitBranch size={13} />}
              disabled={actionsDisabled || !onBranchVersion}
              data-testid={`multi-model-branch-${message.id}`}
            />
          </Tooltip>
        </Dropdown>
        {onDeleteVersion && displayVersions.length > 1 && (
          <Popconfirm
            title={t('chat.deleteConfirm')}
            onConfirm={() => onDeleteVersion(message.id)}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
          >
            <Button
              type="text"
              size="small"
              danger
              disabled={actionsDisabled}
              icon={<Trash2 size={13} />}
              data-testid={`multi-model-delete-${message.id}`}
            />
          </Popconfirm>
        )}
      </div>
    </div>
  );
}


/**
 * Layout switcher row — rendered below ModelTags.
 * Lets users temporarily override the display mode for a specific message.
 */
export function LayoutSwitcher({
  currentMode,
  onModeChange,
}: {
  currentMode: MultiModelDisplayMode;
  onModeChange: (mode: MultiModelDisplayMode) => void;
}) {
  const { token } = theme.useToken();
  const { t } = useTranslation();

  const modes: { key: MultiModelDisplayMode; icon: React.ReactNode; label: string }[] = [
    { key: 'tabs', icon: <LayoutList size={14} />, label: t('settings.multiModelDisplayModeTabs') },
    { key: 'side-by-side', icon: <Columns2 size={14} />, label: t('settings.multiModelDisplayModeSideBySide') },
    { key: 'stacked', icon: <Rows3 size={14} />, label: t('settings.multiModelDisplayModeStacked') },
  ];

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      {modes.map(({ key, icon, label }) => (
        <Tooltip key={key} title={label} mouseEnterDelay={0.3}>
          <div
            onClick={() => onModeChange(key)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 24,
              height: 24,
              borderRadius: token.borderRadiusSM,
              cursor: currentMode === key ? 'default' : 'pointer',
              backgroundColor: currentMode === key ? token.colorPrimaryBg : 'transparent',
              color: currentMode === key ? token.colorPrimary : token.colorTextQuaternary,
              transition: 'all 0.2s',
            }}
          >
            {icon}
          </div>
        </Tooltip>
      ))}
    </div>
  );
}
