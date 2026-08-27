import { Popover, Typography, theme } from 'antd';
import { openingQuestionLabel } from '@/lib/openingQuestions';
import type { RoleIntro } from '@/lib/roleIntro';

interface RoleIntroPanelProps {
  intro: RoleIntro;
  onSelect: (content: string) => void;
}

export function RoleIntroPanel({ intro, onSelect }: RoleIntroPanelProps) {
  const { token } = theme.useToken();

  return (
    <div
      className="flex flex-col items-center justify-center h-full"
      style={{ padding: '0 24px', textAlign: 'center', gap: 16 }}
    >
      {intro.openingMessage ? (
        <Typography.Text
          type="secondary"
          style={{ maxWidth: 620, fontSize: 15, lineHeight: 1.7 }}
        >
          {intro.openingMessage}
        </Typography.Text>
      ) : null}
      {intro.openingQuestions.length > 0 ? (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'center',
            gap: 8,
            marginTop: 4,
          }}
        >
          {intro.openingQuestions.map((question, index) => {
            const label = openingQuestionLabel(question);
            return (
              <Popover
                key={`role-intro-${index}`}
                trigger={['hover', 'focus']}
                content={(
                  <div
                    data-testid="role-intro-preview"
                    style={{
                      maxWidth: 480,
                      maxHeight: 320,
                      overflow: 'auto',
                      whiteSpace: 'pre-wrap',
                      textAlign: 'left',
                      userSelect: 'text',
                      color: token.colorText,
                    }}
                  >
                    {question.content}
                  </div>
                )}
              >
                <button
                  type="button"
                  aria-label={label}
                  onClick={() => onSelect(question.content)}
                  style={{
                    maxWidth: 280,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    border: `1px solid ${token.colorBorder}`,
                    background: token.colorBgContainer,
                    color: token.colorText,
                    borderRadius: token.borderRadius,
                    padding: '4px 15px',
                    cursor: 'pointer',
                    fontSize: token.fontSize,
                    lineHeight: `${token.lineHeight}`,
                  }}
                >
                  {label}
                </button>
              </Popover>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
