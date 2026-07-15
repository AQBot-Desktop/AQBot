import { useEffect, useState, useSyncExternalStore } from 'react';
import { isTauri } from '@/lib/invoke';
import {
  getCachedLegacyAvatarSource,
  getLegacyAvatarSourceCacheRevision,
  loadLegacyAvatarSource,
  subscribeLegacyAvatarSourceCache,
} from '@/lib/legacyAvatarMedia';
import type { AvatarType } from '@/stores/userProfileStore';

const noopSubscribe = () => () => {};
const zeroSnapshot = () => 0;

function getDirectAvatarSource(value: string): string | undefined {
  const normalizedPrefix = value.slice(0, 64).toLowerCase();
  if (
    normalizedPrefix.startsWith('data:image/')
    || normalizedPrefix.startsWith('aqbot-media://stored/')
    || normalizedPrefix.startsWith('http://aqbot-media.localhost/stored/')
    || normalizedPrefix.startsWith('https://aqbot-media.localhost/stored/')
  ) {
    return value;
  }
  return undefined;
}

/**
 * Resolves a file-type avatar value to a renderable src string.
 * - Relative paths are resolved via `read_attachment_preview`.
 */
export function useResolvedAvatarSrc(
  avatarType: AvatarType,
  avatarValue: string,
): string | undefined {
  const directSource = avatarType === 'file'
    ? getDirectAvatarSource(avatarValue)
    : undefined;
  const shouldLoadLegacySource = avatarType === 'file'
    && Boolean(avatarValue)
    && directSource === undefined
    && isTauri();
  const cacheRevision = useSyncExternalStore(
    shouldLoadLegacySource ? subscribeLegacyAvatarSourceCache : noopSubscribe,
    shouldLoadLegacySource ? getLegacyAvatarSourceCacheRevision : zeroSnapshot,
    zeroSnapshot,
  );
  const [resolved, setResolved] = useState<string | undefined>(() => (
    directSource
    ?? (shouldLoadLegacySource ? getCachedLegacyAvatarSource(avatarValue) : undefined)
  ));

  useEffect(() => {
    if (avatarType !== 'file' || !avatarValue) {
      setResolved(undefined);
      return;
    }
    if (directSource !== undefined) {
      setResolved(directSource);
      return;
    }
    if (!shouldLoadLegacySource) {
      setResolved(undefined);
      return;
    }
    setResolved(getCachedLegacyAvatarSource(avatarValue));
    let cancelled = false;
    loadLegacyAvatarSource(avatarValue)
      .then((dataUrl) => {
        if (!cancelled) setResolved(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setResolved(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [avatarType, avatarValue, cacheRevision, directSource, shouldLoadLegacySource]);

  return resolved;
}
