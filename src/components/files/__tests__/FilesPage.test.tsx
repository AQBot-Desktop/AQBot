import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContentArea } from '@/components/layout/ContentArea';
import { FilesPage } from '@/pages/FilesPage';

vi.mock('@/pages/ChatPage', () => ({ ChatPage: () => <div>chat</div> }));
vi.mock('@/pages/GatewayPage', () => ({ GatewayPage: () => <div>gateway</div> }));
vi.mock('@/pages/SettingsPage', () => ({ SettingsPage: () => <div>settings</div> }));

// ──────────────────────────────────────────────────────────────────────────────
// Task 3: list layout + controls
// ──────────────────────────────────────────────────────────────────────────────
describe('FilesPage list layout', () => {
  it('all categories render a list presentation', async () => {
    const user = userEvent.setup();
    render(<FilesPage />);
    const sidebar = screen.getByTestId('files-sidebar');

    // images (default)
    expect(screen.getByTestId('file-list')).toBeDefined();

    // switch to 文件
    await user.click(within(sidebar).getByText('文件'));
    expect(screen.getByTestId('file-list')).toBeDefined();

    // switch to 备份
    await user.click(within(sidebar).getByText('备份'));
    expect(screen.getByTestId('file-list')).toBeDefined();
  });

  it('right pane shows sort controls for 创建时间, 大小, 文件名', () => {
    render(<FilesPage />);
    const content = screen.getByTestId('files-content');
    expect(within(content).getByText('创建时间')).toBeDefined();
    expect(within(content).getByText('大小')).toBeDefined();
    expect(within(content).getByText('文件名')).toBeDefined();
  });

  it('search input is scoped to the active category', async () => {
    const user = userEvent.setup();
    render(<FilesPage />);

    const sidebar = screen.getByTestId('files-sidebar');

    // default category is images
    expect(screen.getByTestId('category-search')).toHaveAttribute('data-category', 'images');

    // switch to 文件 → search scope updates
    await user.click(within(sidebar).getByText('文件'));
    expect(screen.getByTestId('category-search')).toHaveAttribute('data-category', 'files');

    // switch to 备份 → search scope updates
    await user.click(within(sidebar).getByText('备份'));
    expect(screen.getByTestId('category-search')).toHaveAttribute('data-category', 'backups');
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
    await user.click(within(screen.getByTestId('files-sidebar')).getByText('文件'));

    // Search should be cleared for the new category
    const newSearchInput = screen.getByPlaceholderText('搜索文件…');
    expect(newSearchInput).toHaveValue('');
  });

  it('sort selection resets to 创建时间 when switching category', async () => {
    const user = userEvent.setup();
    render(<FilesPage />);

    // Click a non-default sort button
    await user.click(screen.getByText('大小'));
    expect(screen.getByText('大小').closest('button')).toHaveClass('ant-btn-primary');
    expect(screen.getByText('创建时间').closest('button')).not.toHaveClass('ant-btn-primary');

    // Switch to 文件
    await user.click(within(screen.getByTestId('files-sidebar')).getByText('文件'));

    // Sort should be back to 创建时间
    expect(screen.getByText('创建时间').closest('button')).toHaveClass('ant-btn-primary');
    expect(screen.getByText('大小').closest('button')).not.toHaveClass('ant-btn-primary');
  });
});

describe('ContentArea routing — files', () => {
  it('renders FilesPage when activePage is "files"', () => {
    render(<ContentArea activePage="files" />);
    // The real FilesPage renders a sidebar; verify it is present
    expect(screen.getByTestId('files-sidebar')).toBeDefined();
  });
});

describe('FilesPage two-pane shell', () => {
  it('renders secondary sidebar with 图片, 文件, 备份 categories', () => {
    render(<FilesPage />);
    const sidebar = screen.getByTestId('files-sidebar');
    expect(within(sidebar).getByText('图片')).toBeDefined();
    expect(within(sidebar).getByText('文件')).toBeDefined();
    expect(within(sidebar).getByText('备份')).toBeDefined();
  });

  it('renders the right-pane content shell', () => {
    render(<FilesPage />);
    expect(screen.getByTestId('files-content')).toBeDefined();
  });

  it('selects 图片 as the default category', () => {
    render(<FilesPage />);
    expect(screen.getByTestId('files-content')).toHaveAttribute('data-category', 'images');
  });

  it('switching category updates the right pane while staying inside FilesPage', async () => {
    const user = userEvent.setup();
    render(<FilesPage />);

    const sidebar = screen.getByTestId('files-sidebar');

    // sidebar and content both present before switch
    expect(sidebar).toBeDefined();
    expect(screen.getByTestId('files-content')).toHaveAttribute('data-category', 'images');

    await user.click(within(sidebar).getByText('文件'));

    // content updated, sidebar still present
    expect(screen.getByTestId('files-content')).toHaveAttribute('data-category', 'files');
    expect(screen.getByTestId('files-sidebar')).toBeDefined();
  });
});
