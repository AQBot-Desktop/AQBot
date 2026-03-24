import { useMemo, useCallback } from 'react';
import { Tag, Space, Tooltip, theme } from 'antd';
import { Bot, Search, Wrench, BookOpen, Lightbulb } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface ContextBarProps {
  modelName?: string;
  searchEnabled?: boolean;
  toolCount?: number;
  knowledgeCount?: number;
  memoryEnabled?: boolean;
  onChipClick?: (type: string) => void;
}

export function ContextBar({
  modelName,
  searchEnabled = false,
  toolCount = 0,
  knowledgeCount = 0,
  memoryEnabled = false,
  onChipClick,
}: ContextBarProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();

  const handleClick = useCallback(
    (type: string) => {
      onChipClick?.(type);
    },
    [onChipClick],
  );

  const chips = useMemo(
    () => [
      ...(modelName
        ? [
            {
              key: 'model',
              icon: <Bot size={14} />,
              label: modelName,
              color: 'purple' as const,
              tooltip: t('chat.context.model'),
            },
          ]
        : []),
      {
        key: 'search',
        icon: <Search size={14} />,
        label: searchEnabled ? t('chat.context.enabled') : t('chat.context.disabled'),
        color: (searchEnabled ? 'green' : 'default') as string,
        tooltip: t('chat.context.search'),
      },
      {
        key: 'tools',
        icon: <Wrench size={14} />,
        label: t('chat.context.count', { count: toolCount }),
        color: (toolCount > 0 ? 'blue' : 'default') as string,
        tooltip: t('chat.context.tools'),
      },
      {
        key: 'knowledge',
        icon: <BookOpen size={14} />,
        label: t('chat.context.count', { count: knowledgeCount }),
        color: (knowledgeCount > 0 ? 'blue' : 'default') as string,
        tooltip: t('chat.context.knowledge'),
      },
      {
        key: 'memory',
        icon: <Lightbulb size={14} />,
        label: memoryEnabled ? t('chat.context.enabled') : t('chat.context.disabled'),
        color: (memoryEnabled ? 'green' : 'default') as string,
        tooltip: t('chat.context.memory'),
      },
    ],
    [modelName, searchEnabled, toolCount, knowledgeCount, memoryEnabled, t],
  );

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 16px',
        borderBottom: '1px solid var(--border-color)',
        backgroundColor: token.colorBgContainer,
        overflowX: 'auto',
      }}
    >
      <Space size={[4, 4]} wrap>
        {chips.map((chip) => (
          <Tooltip key={chip.key} title={chip.tooltip}>
            <Tag
              icon={chip.icon}
              color={chip.color}
              style={{ cursor: onChipClick ? 'pointer' : 'default', margin: 0 }}
              onClick={() => handleClick(chip.key)}
            >
              {chip.label}
            </Tag>
          </Tooltip>
        ))}
      </Space>
    </div>
  );
}
