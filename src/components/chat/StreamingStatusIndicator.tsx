import { useEffect, useState } from 'react';
import { Typography, theme } from 'antd';
import { useTranslation } from 'react-i18next';
import { useStreamActivity } from '@/hooks/useStreamActivity';
import { selectUiStreaming, useConversationStore } from '@/stores/conversationStore';
import { getStreamingStatusPresentation } from './chatStreaming';

export function StreamingStatusIndicator({
  messageId,
  hasModelText,
  style,
}: {
  messageId?: string | null;
  hasModelText: boolean;
  style?: React.CSSProperties;
}) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const streaming = useConversationStore(selectUiStreaming);
  const activity = useStreamActivity(messageId);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!streaming) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [streaming]);

  const presentation = getStreamingStatusPresentation({
    isStreaming: streaming,
    activity,
    now,
    hasModelText,
  });
  if (!presentation) return null;

  const color = presentation.tone === 'warning' ? token.colorWarning : token.colorPrimary;
  return (
    <span
      className="aqbot-streaming-status"
      aria-label={t(presentation.labelKey)}
      style={{ color, ...style }}
    >
      <span className="aqbot-streaming-dots" aria-hidden="true">
        <span /><span /><span />
      </span>
      <Typography.Text style={{ fontSize: 12, color }}>
        {t(presentation.labelKey)}
      </Typography.Text>
    </span>
  );
}
