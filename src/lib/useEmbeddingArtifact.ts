import { useCallback, useEffect, useState } from 'react';
import { invoke, listen } from '@/lib/invoke';

export type EmbeddingArtifactStatus = {
  status: string;
  artifactId: string;
  revision: string;
  path: string;
  sizeBytes: number;
  downloadedBytes: number;
  license: string;
};

export type EmbeddingArtifactProgress = {
  status: string;
  downloadedBytes: number;
  totalBytes: number;
};

export function useEmbeddingArtifact() {
  const [status, setStatus] = useState<EmbeddingArtifactStatus | null>(null);
  const [progress, setProgress] = useState<EmbeddingArtifactProgress | null>(null);

  const refresh = useCallback(async () => {
    const next = await invoke<EmbeddingArtifactStatus>('get_embedding_artifact_status');
    setStatus(next);
    if (next.status !== 'downloading') setProgress(null);
  }, []);

  useEffect(() => {
    void refresh();
    let unlisten: (() => void) | undefined;
    void listen<EmbeddingArtifactProgress>('embedding-artifact-progress', (event) => {
      setProgress(event.payload);
      if (event.payload.status !== 'downloading') {
        void refresh();
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [refresh]);

  const currentStatus = progress?.status ?? status?.status ?? 'missing';
  const downloaded = progress?.downloadedBytes ?? status?.downloadedBytes ?? 0;
  const total = progress?.totalBytes ?? status?.sizeBytes ?? 0;

  return { status, progress, currentStatus, downloaded, total, refresh };
}
