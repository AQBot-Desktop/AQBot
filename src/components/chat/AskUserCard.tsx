import React, { useState } from 'react';
import { Card, Input, Button, Space, Typography } from 'antd';
import { MessageCircleQuestion } from 'lucide-react';
import { useAgentStore } from '@/stores';
import { useTranslation } from 'react-i18next';

const { Text } = Typography;
const { TextArea } = Input;

interface AskUserCardProps {
  askId: string;
  conversationId: string;
  question: string;
}

const AskUserCard: React.FC<AskUserCardProps> = ({ askId, question }) => {
  const { t } = useTranslation();
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const respondAskUser = useAgentStore((s) => s.respondAskUser);

  const handleSubmit = async () => {
    if (!answer.trim()) return;
    setSubmitting(true);
    try {
      await respondAskUser(askId, answer.trim());
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card
      size="small"
      style={{ marginTop: 8, borderColor: '#1677ff' }}
      styles={{ body: { padding: '12px 16px' } }}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        <Space size={8} align="start">
          <MessageCircleQuestion size={16} style={{ color: '#1677ff', flexShrink: 0, marginTop: 2 }} />
          <Text style={{ whiteSpace: 'pre-wrap' }}>{question}</Text>
        </Space>
        <TextArea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder={t('agent.askUserPlaceholder', 'Type your answer...')}
          autoSize={{ minRows: 1, maxRows: 4 }}
          onPressEnter={(e) => {
            if (!e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button
            type="primary"
            size="small"
            onClick={handleSubmit}
            loading={submitting}
            disabled={!answer.trim()}
          >
            {t('agent.askUserSubmit', 'Submit')}
          </Button>
        </div>
      </Space>
    </Card>
  );
};

export default AskUserCard;
