import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FilesContent } from '../FilesContent';

const mockStoreBase = {
  rows: [],
  loading: false,
  error: null as string | null,
  search: '',
  sortKey: 'createdAt' as const,
  loadCategory: vi.fn().mockResolvedValue(undefined),
  setSearch: vi.fn(),
  setSortKey: vi.fn(),
  clearError: vi.fn(),
  openEntry: vi.fn().mockResolvedValue(undefined),
  revealEntry: vi.fn().mockResolvedValue(undefined),
  cleanupMissingEntry: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@/stores/fileStore', () => ({
  useFileStore: vi.fn(() => ({ ...mockStoreBase })),
}));

// Re-import after mock is set up.
import { useFileStore } from '@/stores/fileStore';

const mockUseFileStore = vi.mocked(useFileStore);

beforeEach(() => {
  vi.clearAllMocks();
  mockUseFileStore.mockReturnValue({ ...mockStoreBase, error: null });
});

describe('FilesContent — error visibility', () => {
  it('does not render an error alert when error is null', () => {
    render(<FilesContent activeCategory="images" />);
    expect(screen.queryByTestId('files-error-alert')).toBeNull();
  });

  it('renders a visible error alert when the store has an error', () => {
    mockUseFileStore.mockReturnValue({
      ...mockStoreBase,
      error: 'Failed to open file: permission denied',
    });

    render(<FilesContent activeCategory="images" />);

    const alert = screen.getByTestId('files-error-alert');
    expect(alert).toBeDefined();
    expect(alert.textContent).toContain('Failed to open file: permission denied');
  });

  it('calls clearError when the alert close button is clicked', async () => {
    const clearError = vi.fn();
    mockUseFileStore.mockReturnValue({
      ...mockStoreBase,
      error: 'reveal failed',
      clearError,
    });

    const user = userEvent.setup();
    render(<FilesContent activeCategory="images" />);

    const closeBtn = screen.getByRole('button', { name: /close/i });
    await user.click(closeBtn);

    expect(clearError).toHaveBeenCalledOnce();
  });

  it('shows errors for all three categories (not just images)', () => {
    mockUseFileStore.mockReturnValue({
      ...mockStoreBase,
      error: 'cleanup failed',
    });

    const { rerender } = render(<FilesContent activeCategory="files" />);
    expect(screen.getByTestId('files-error-alert').textContent).toContain('cleanup failed');

    rerender(<FilesContent activeCategory="backups" />);
    expect(screen.getByTestId('files-error-alert').textContent).toContain('cleanup failed');
  });
});
