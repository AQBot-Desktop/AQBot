import { Card, Row, Col, Typography, Tag, Empty } from 'antd';
import { GitBranch } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface BranchMessage {
  id: string;
  content: string;
  model?: string;
  created_at?: number;
}

interface BranchComparePanelProps {
  leftMessage?: BranchMessage;
  rightMessage?: BranchMessage;
}

function formatTimestamp(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function MessageCard({ message, side }: { message?: BranchMessage; side: string }) {
  const { t } = useTranslation();

  if (!message) {
    return (
      <Card size="small" style={{ height: '100%' }}>
        <Empty description={t('common.noData')} />
      </Card>
    );
  }

  return (
    <Card
      size="small"
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Tag>{side}</Tag>
          {message.model && <Typography.Text>{message.model}</Typography.Text>}
          {message.created_at && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatTimestamp(message.created_at)}
            </Typography.Text>
          )}
        </div>
      }
    >
      <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
        {message.content}
      </Typography.Paragraph>
    </Card>
  );
}

export function BranchComparePanel({ leftMessage, rightMessage }: BranchComparePanelProps) {
  const { t } = useTranslation();

  if (!leftMessage && !rightMessage) {
    return <Empty description={t('chat.branch.compare')} style={{ marginTop: 32 }} />;
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <GitBranch size={16} />
        <Typography.Text>{t('chat.branch.compare')}</Typography.Text>
      </div>
      <Row gutter={12}>
        <Col span={12}>
          <MessageCard message={leftMessage} side={t('chat.branch.left')} />
        </Col>
        <Col span={12}>
          <MessageCard message={rightMessage} side={t('chat.branch.right')} />
        </Col>
      </Row>
    </div>
  );
}
