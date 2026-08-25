import type { Message, MultiModelDisplayMode, MultiModelTarget } from '@/types';
import { getMessageVersionGroupKey, getModelVersionGroupKey, selectDisplayVersionsByModel } from '@/lib/chatMultiModel';

export interface LaneColumn {
  key: string;
  providerId: string;
  modelId: string;
  historical: boolean;
}

export function buildLaneColumns(
  currentTargets: ReadonlyArray<MultiModelTarget>,
): LaneColumn[] {
  const columns: LaneColumn[] = [];
  const seen = new Set<string>();

  for (const target of currentTargets) {
    const key = getModelVersionGroupKey(target.providerId, target.modelId);
    if (seen.has(key)) continue;
    seen.add(key);
    columns.push({
      key,
      providerId: target.providerId,
      modelId: target.modelId,
      historical: false,
    });
  }

  return columns;
}

export function comparisonDisplayModeForChrome(
  chromeKind: 'main' | 'popout',
  conversationMode: MultiModelDisplayMode,
): MultiModelDisplayMode {
  return chromeKind === 'popout' ? 'side-by-side' : conversationMode;
}

export function shouldUseLaneWorkspace(
  chromeKind: 'main' | 'popout',
  columns: LaneColumn[],
): boolean {
  return chromeKind === 'popout' && columns.length >= 2;
}

export function selectLaneAnswer(
  versions: Message[],
  column: LaneColumn,
  activeMessageId?: string | null,
  displayMessageIdsByModelKey?: ReadonlyMap<string, string> | Record<string, string | undefined> | null,
): Message | null {
  return selectDisplayVersionsByModel(versions, activeMessageId, displayMessageIdsByModelKey)
    .find((version) => getMessageVersionGroupKey(version) === column.key) ?? null;
}
