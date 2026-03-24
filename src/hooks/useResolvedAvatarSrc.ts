import { useState, useEffect } from 'react';
import { invoke, isTauri } from '@/lib/invoke';
import type { AvatarType } from '@/stores/userProfileStore';

/**
 * Resolves a file-type avatar value to a renderable src string.
 * - Relative paths are resolved via `read_attachment_preview`.
 */
export function useResolvedAvatarSrc(
  avatarType: AvatarType,
  avatarValue: string,
): string | undefined {
  const [resolved, setResolved] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (avatarType !== 'file' || !avatarValue) {
      setResolved(undefined);
      return;
    }
    // Relative path → resolve via Rust command
    if (!isTauri()) {
      setResolved(undefined);
      return;
    }
    let cancelled = false;
    invoke<string>('read_attachment_preview', { filePath: avatarValue })
      .then((dataUrl) => {
        if (!cancelled) setResolved(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setResolved(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [avatarType, avatarValue]);

  return resolved;
}
