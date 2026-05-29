import { memo } from 'react';
import { theme } from 'antd';
import { ModelIcon, modelMappings } from '@lobehub/icons';
import { Brain } from 'lucide-react';

type ConversationModelIconProps = {
  model: string;
  size: number;
};

const FALLBACK_MODEL_IDS = new Set(['unknown-model', 'unknown', 'default', 'kelivo']);

function normalizeModelName(model: string): string {
  return model.trim().toLowerCase().replace(/\s+/g, '');
}

function hasKnownModelIcon(model: string): boolean {
  const normalized = normalizeModelName(model);
  return modelMappings.some((mapping: { keywords: string[] }) =>
    mapping.keywords.some((keyword) => {
      try {
        return new RegExp(keyword, 'i').test(normalized);
      } catch {
        return normalized.includes(keyword.toLowerCase());
      }
    }),
  );
}

function shouldUseFallbackIcon(model: string): boolean {
  const normalized = normalizeModelName(model);
  return !normalized || FALLBACK_MODEL_IDS.has(normalized) || !hasKnownModelIcon(model);
}

export const ConversationModelIcon = memo(function ConversationModelIcon({
  model,
  size,
}: ConversationModelIconProps) {
  const { token } = theme.useToken();
  if (shouldUseFallbackIcon(model)) {
    return (
      <span
        className="aqbot-conversation-model-icon"
        style={{
          width: size,
          height: size,
          minWidth: size,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          lineHeight: 0,
          borderRadius: '50%',
          overflow: 'hidden',
          backgroundColor: token.colorFillSecondary,
          color: token.colorTextSecondary,
        }}
      >
        <Brain size={Math.round(size * 0.58)} strokeWidth={1.8} style={{ display: 'block' }} />
      </span>
    );
  }

  return (
    <span
      className="aqbot-conversation-model-icon"
      style={{
        width: size,
        height: size,
        minWidth: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        lineHeight: 0,
        borderRadius: '50%',
        overflow: 'hidden',
      }}
    >
      <ModelIcon model={model} size={size} type="avatar" />
    </span>
  );
});
