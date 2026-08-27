import { Button, Input, Space, theme } from 'antd';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { OPENING_QUESTION_TITLE_MAX_CHARS, type OpeningQuestionDraft } from '@/lib/openingQuestions';

interface OpeningQuestionsEditorProps {
  items: OpeningQuestionDraft[];
  onChange: (items: OpeningQuestionDraft[]) => void;
  errorIndex?: number;
}

export function OpeningQuestionsEditor({
  items,
  onChange,
  errorIndex,
}: OpeningQuestionsEditorProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();

  const updateItem = (index: number, patch: Partial<OpeningQuestionDraft>) => {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  return (
    <Space orientation="vertical" style={{ width: '100%' }} size={8}>
      {items.map((question, index) => (
        <div
          key={index}
          data-opening-question-index={index}
          style={{
            border: `1px solid ${index === errorIndex ? token.colorError : token.colorBorderSecondary}`,
            borderRadius: 8,
            padding: 10,
            background: token.colorFillAlter,
          }}
        >
          <Space orientation="vertical" style={{ width: '100%' }} size={8}>
            <Input
              value={question.title}
              maxLength={OPENING_QUESTION_TITLE_MAX_CHARS}
              showCount
              aria-label={t('roles.openingQuestionTitle')}
              placeholder={t('roles.openingQuestionTitlePlaceholder')}
              onChange={(event) => updateItem(index, { title: event.target.value })}
            />
            <Input.TextArea
              value={question.content}
              autoSize={{ minRows: 3, maxRows: 10 }}
              aria-label={t('roles.openingQuestionPlaceholder')}
              placeholder={t('roles.openingQuestionPlaceholder')}
              onChange={(event) => updateItem(index, { content: event.target.value })}
            />
            <Button
              aria-label={t('roles.removeOpeningQuestion')}
              icon={<Trash2 size={14} />}
              onClick={() => onChange(items.filter((_, i) => i !== index))}
            >
              {t('roles.removeOpeningQuestion')}
            </Button>
          </Space>
        </div>
      ))}
      <Button
        icon={<Plus size={14} />}
        onClick={() => onChange([...items, { title: '', content: '' }])}
      >
        {t('roles.addOpeningQuestion')}
      </Button>
    </Space>
  );
}
