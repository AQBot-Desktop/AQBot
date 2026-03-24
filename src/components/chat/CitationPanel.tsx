import { List, Typography, Tag, Empty } from 'antd';
import { Link } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Citation {
  id: string;
  title: string;
  url?: string;
  snippet: string;
  source: 'search' | 'knowledge' | 'memory';
}

interface CitationPanelProps {
  citations: Citation[];
}

const sourceColorMap: Record<Citation['source'], string> = {
  search: 'blue',
  knowledge: 'green',
  memory: 'purple',
};

export function CitationPanel({ citations }: CitationPanelProps) {
  const { t } = useTranslation();

  if (citations.length === 0) {
    return <Empty description={t('common.noData')} style={{ marginTop: 32 }} />;
  }

  return (
    <List
      dataSource={citations}
      renderItem={(item) => (
        <List.Item key={item.id}>
          <div style={{ width: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Typography.Text>{item.title}</Typography.Text>
              <Tag color={sourceColorMap[item.source]}>{item.source}</Tag>
            </div>
            <Typography.Paragraph
              type="secondary"
              ellipsis={{ rows: 2 }}
              style={{ marginBottom: 4, fontSize: 13 }}
            >
              {item.snippet}
            </Typography.Paragraph>
            {item.url && (
              <a href={item.url} target="_blank" rel="noopener noreferrer">
                <Link size={14} style={{ marginRight: 4 }} />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {item.url}
                </Typography.Text>
              </a>
            )}
          </div>
        </List.Item>
      )}
    />
  );
}
