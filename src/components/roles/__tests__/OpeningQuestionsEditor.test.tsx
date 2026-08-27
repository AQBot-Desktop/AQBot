import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { OpeningQuestionsEditor } from '../OpeningQuestionsEditor';
import type { OpeningQuestionDraft } from '@/lib/openingQuestions';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'roles.openingQuestionTitle': '标题',
        'roles.openingQuestionTitlePlaceholder': '可选短标题',
        'roles.openingQuestionPlaceholder': '输入一个开场问题',
        'roles.addOpeningQuestion': '添加问题',
        'roles.removeOpeningQuestion': '删除问题',
      };
      return map[key] ?? key;
    },
  }),
}));

function EditorHarness({ initial = [] as OpeningQuestionDraft[] }) {
  const [items, setItems] = useState<OpeningQuestionDraft[]>(initial);
  return <OpeningQuestionsEditor items={items} onChange={setItems} />;
}

describe('OpeningQuestionsEditor', () => {
  it('adds a card and keeps multiline content', async () => {
    const user = userEvent.setup();
    render(<EditorHarness />);

    await user.click(screen.getByRole('button', { name: '添加问题' }));
    await user.type(screen.getByLabelText('标题'), '翻译');
    await user.type(screen.getByLabelText('输入一个开场问题'), '第一行{Enter}第二行');

    expect(screen.getByLabelText('标题')).toHaveValue('翻译');
    expect(screen.getByLabelText('输入一个开场问题')).toHaveValue('第一行\n第二行');
  });

  it('removes a card without shifting the remaining item', async () => {
    const user = userEvent.setup();
    render(
      <EditorHarness
        initial={[
          { title: 'A', content: '正文A' },
          { title: 'B', content: '正文B' },
        ]}
      />,
    );

    await user.click(screen.getAllByRole('button', { name: '删除问题' })[0]);
    expect(screen.getByLabelText('标题')).toHaveValue('B');
    expect(screen.getByLabelText('输入一个开场问题')).toHaveValue('正文B');
  });
});
