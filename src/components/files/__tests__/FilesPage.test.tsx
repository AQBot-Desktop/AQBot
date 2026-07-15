import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContentArea } from '@/components/layout/ContentArea';
import { FilesPage } from '@/pages/FilesPage';

vi.mock('@/pages/ChatPage', () => ({ ChatPage: () => <div>chat</div> }));
vi.mock('@/pages/DrawingPage', () => ({ DrawingPage: () => <div>drawing</div> }));
vi.mock('@/pages/KnowledgePage', () => ({ KnowledgePage: () => <div>knowledge</div> }));
vi.mock('@/pages/MemoryPage', () => ({ MemoryPage: () => <div>memory</div> }));
vi.mock('@/pages/GatewayPage', () => ({ GatewayPage: () => <div>gateway</div> }));
vi.mock('@/pages/SettingsPage', () => ({ SettingsPage: () => <div>settings</div> }));
vi.mock('@/pages/SkillsPage', () => ({ SkillsPage: () => <div>skills</div> }));
vi.mock('@/pages/RolesPage', () => ({ RolesPage: () => <div>roles</div> }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'files.images': '图片',
        'files.files': '文件',
        'files.columnName': '文件名',
        'files.columnSize': '大小',
        'files.columnCreatedAt': '创建时间',
        'files.columnActions': '操作',
        'files.batchDelete': '批量删除',
        'files.empty': '暂无文件',
      };
      if (key === 'files.searchPlaceholder') {
        return `搜索${String(options?.category ?? '')}…`;
      }
      return translations[key] ?? key;
    },
  }),
}));

// ──────────────────────────────────────────────────────────────────────────────
// Task 3: list layout + controls
// ──────────────────────────────────────────────────────────────────────────────
describe('FilesPage list layout', () => {
  it('all categories render a table presentation', async () => {
    const user = userEvent.setup();
    render(<FilesPage />);
    const tabs = screen.getByRole('tablist');

    // images (default)
    expect(screen.getByRole('table')).toBeInTheDocument();

    // switch to 文件
    await user.click(within(tabs).getByRole('tab', { name: '文件' }));
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByTestId('files-content')).toHaveAttribute('data-category', 'files');
  });

  it('content table exposes sortable 创建时间, 大小, 文件名 columns', () => {
    render(<FilesPage />);
    const content = screen.getByTestId('files-content');
    expect(within(content).getByRole('columnheader', { name: /创建时间/ })).toHaveAttribute('aria-sort', 'descending');
    expect(within(content).getByRole('columnheader', { name: /大小/ })).toHaveClass('ant-table-column-has-sorters');
    expect(within(content).getByRole('columnheader', { name: /文件名/ })).toHaveClass('ant-table-column-has-sorters');
  });

  it('search input is scoped to the active category', async () => {
    const user = userEvent.setup();
    render(<FilesPage />);

    const tabs = screen.getByRole('tablist');

    // default category is images
    expect(screen.getByTestId('category-search')).toHaveAttribute('data-category', 'images');

    // switch to 文件 → search scope updates
    await user.click(within(tabs).getByRole('tab', { name: '文件' }));
    expect(screen.getByTestId('category-search')).toHaveAttribute('data-category', 'files');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Task 3 code-review fix: sort/search reset on category switch
// ──────────────────────────────────────────────────────────────────────────────
describe('FilesPage — sort and search reset on category switch', () => {
  it('search input is cleared when switching category', async () => {
    const user = userEvent.setup();
    render(<FilesPage />);

    // Type into the search input on the default (images) category
    const searchInput = screen.getByPlaceholderText('搜索图片…');
    await user.type(searchInput, 'hello');
    expect(searchInput).toHaveValue('hello');

    // Switch to 文件
    await user.click(screen.getByRole('tab', { name: '文件' }));

    // Search should be cleared for the new category
    const newSearchInput = screen.getByPlaceholderText('搜索文件…');
    expect(newSearchInput).toHaveValue('');
  });

  it('sort selection resets to 创建时间 when switching category', async () => {
    const user = userEvent.setup();
    render(<FilesPage />);

    // Select a non-default table sort column.
    await user.click(screen.getByRole('columnheader', { name: /大小/ }));
    expect(screen.getByRole('columnheader', { name: /大小/ })).toHaveAttribute('aria-sort', 'ascending');

    // Switch to 文件
    await user.click(screen.getByRole('tab', { name: '文件' }));

    // The newly mounted category returns to the table's default sort.
    expect(screen.getByRole('columnheader', { name: /创建时间/ })).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByRole('columnheader', { name: /大小/ })).not.toHaveAttribute('aria-sort');
  });
});

describe('ContentArea routing — files', () => {
  it('renders FilesPage when activePage is "files"', () => {
    render(<ContentArea activePage="files" />);
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.getByTestId('files-content')).toHaveAttribute('data-category', 'images');
  });
});

describe('FilesPage tab shell', () => {
  it('renders 图片 and 文件 category tabs', () => {
    render(<FilesPage />);
    const tabs = screen.getByRole('tablist');
    expect(within(tabs).getByRole('tab', { name: '图片' })).toBeInTheDocument();
    expect(within(tabs).getByRole('tab', { name: '文件' })).toBeInTheDocument();
  });

  it('renders the active category content shell', () => {
    render(<FilesPage />);
    expect(screen.getByTestId('files-content')).toBeDefined();
  });

  it('selects 图片 as the default category', () => {
    render(<FilesPage />);
    expect(screen.getByRole('tab', { name: '图片' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('files-content')).toHaveAttribute('data-category', 'images');
  });

  it('switching category updates the right pane while staying inside FilesPage', async () => {
    const user = userEvent.setup();
    render(<FilesPage />);

    const tabs = screen.getByRole('tablist');

    // tabs and content both present before switch
    expect(tabs).toBeInTheDocument();
    expect(screen.getByTestId('files-content')).toHaveAttribute('data-category', 'images');

    await user.click(within(tabs).getByRole('tab', { name: '文件' }));

    // content updated, tab shell remains mounted
    expect(screen.getByTestId('files-content')).toHaveAttribute('data-category', 'files');
    expect(screen.getByRole('tablist')).toBe(tabs);
    expect(screen.getByRole('tab', { name: '文件' })).toHaveAttribute('aria-selected', 'true');
  });
});
