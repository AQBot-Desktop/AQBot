import { Card, Empty, Tag, Typography } from 'antd';
import { FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface ArtifactPanelProps {
  artifact?: {
    id: string;
    title: string;
    kind: string;
    content: string;
    format: string;
  };
}

export function ArtifactPanel({ artifact }: ArtifactPanelProps) {
  const { t } = useTranslation();

  if (!artifact) {
    return <Empty description={t('chat.artifacts.empty')} style={{ marginTop: 32 }} />;
  }

  return (
    <Card
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <FileText size={16} />
          <span>{artifact.title}</span>
          <Tag>{artifact.kind}</Tag>
        </div>
      }
      size="small"
    >
      <Typography.Paragraph ellipsis={{ rows: 6, expandable: true, symbol: '...' }}>
        {artifact.content}
      </Typography.Paragraph>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t('chat.artifacts.comingSoon', 'Full edit coming in Phase 2.2')}
      </Typography.Text>
    </Card>
  );
}
