import type React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalRetrievalEngineCard } from '../LocalRetrievalEngineCard';

const invokeMock = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/lib/invoke', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  listen: async () => () => {},
}));

vi.mock('../SettingsGroup', () => ({
  SettingsGroup: ({ title, children }: { title?: string; children?: React.ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));

describe('LocalRetrievalEngineCard', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({
      status: 'missing',
      artifactId: 'multilingual-e5-small',
      revision: '761b726',
      path: '/tmp/aqbot/models/embeddings/multilingual-e5-small/761b726/onnx/model_int8.onnx',
      sizeBytes: 118054593,
      downloadedBytes: 0,
      license: 'MIT',
    });
  });

  it('shows a one-click install action when the artifact is missing', async () => {
    render(<LocalRetrievalEngineCard />);
    expect(await screen.findByRole('button', { name: 'settings.localRetrieval.install' })).toBeInTheDocument();
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('get_embedding_artifact_status');
    });
  });

  it('shows uninstall when the artifact is installed', async () => {
    invokeMock.mockResolvedValue({
      status: 'installed',
      artifactId: 'multilingual-e5-small',
      revision: '761b726',
      path: '/tmp/model.onnx',
      sizeBytes: 118054593,
      downloadedBytes: 118054593,
      license: 'MIT',
    });
    render(<LocalRetrievalEngineCard />);
    expect(await screen.findByRole('button', { name: 'settings.localRetrieval.uninstall' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'settings.localRetrieval.install' })).not.toBeInTheDocument();
  });
});
