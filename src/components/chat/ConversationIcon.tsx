import { memo } from 'react';
import { Avatar, theme } from 'antd';
import { Loader } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getConvIcon } from '@/lib/convIcon';
import { findStoredModelIcon } from '@/lib/providerIcons';
import { useResolvedAvatarSrc } from '@/hooks/useResolvedAvatarSrc';
import { useProviderStore } from '@/stores/providerStore';
import type { AvatarType } from '@/stores/userProfileStore';
import type { Conversation } from '@/types';
import { ConversationModelIcon } from './ConversationModelIcon';

export type ConversationIconProps = {
  conv: Pick<Conversation, 'id' | 'title' | 'model_id' | 'provider_id' | 'mode'>;
  isStreaming?: boolean;
  size?: number;
};

/**
 * Conversation list icon: custom avatar → model icon → title initial.
 * Shared by sidebar list and global search results.
 */
export const ConversationIcon = memo(function ConversationIcon({
  conv,
  isStreaming = false,
  size = 20,
}: ConversationIconProps) {
  const { token } = theme.useToken();
  const { t } = useTranslation();
  const providers = useProviderStore((state) => state.providers);
  const modelIcon = findStoredModelIcon(providers, conv.provider_id, conv.model_id);
  const customIcon = getConvIcon(conv.id);
  const resolvedSrc = useResolvedAvatarSrc(
    (customIcon?.type as AvatarType) ?? 'icon',
    customIcon?.value ?? '',
  );
  let icon: React.ReactNode;

  if (customIcon) {
    if (customIcon.type === 'emoji') {
      icon = (
        <Avatar size={size} style={{ fontSize: Math.max(10, size * 0.6), backgroundColor: token.colorPrimaryBg }}>
          {customIcon.value}
        </Avatar>
      );
    } else {
      const src = customIcon.type === 'file'
        ? (resolvedSrc ?? (customIcon.value.startsWith('data:') ? customIcon.value : undefined))
        : customIcon.value;
      icon = <Avatar size={size} src={src} />;
    }
  } else if (conv.model_id) {
    icon = <ConversationModelIcon model={conv.model_id} icon={modelIcon} size={size} />;
  } else {
    icon = (
      <Avatar
        size={size}
        style={{
          fontSize: Math.max(10, size * 0.6),
          backgroundColor: token.colorPrimaryBg,
          color: token.colorPrimary,
        }}
      >
        {(conv.title || '对')[0]}
      </Avatar>
    );
  }

  const modeBadge = conv.mode === 'agent'
    ? t('common.agentMode')
    : conv.mode === 'role'
      ? t('nav.roles')
      : null;
  if (modeBadge) {
    icon = (
      <span style={{ position: 'relative', display: 'inline-flex', width: size, height: size }}>
        {icon}
        <span
          style={{
            position: 'absolute',
            top: -5,
            right: -11,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxSizing: 'border-box',
            padding: '0 3px',
            height: 10,
            lineHeight: 1,
            borderRadius: 5,
            fontSize: 7,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            color: token.colorPrimary,
            background: token.colorPrimaryBg,
            border: `1px solid ${token.colorBgContainer}`,
            pointerEvents: 'none',
            transform: 'scale(0.9)',
            transformOrigin: 'right top',
          }}
        >
          {modeBadge}
        </span>
      </span>
    );
  }

  if (isStreaming) {
    icon = (
      <span style={{ position: 'relative', display: 'inline-flex' }}>
        {icon}
        <Loader
          size={Math.max(8, Math.round(size * 0.5))}
          style={{
            position: 'absolute',
            bottom: -3,
            right: -3,
            color: token.colorPrimary,
            background: token.colorBgContainer,
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
          }}
        />
      </span>
    );
  }

  return icon;
});
