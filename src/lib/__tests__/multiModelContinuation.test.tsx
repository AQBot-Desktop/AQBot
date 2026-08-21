import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getMultiModelContinuationMode,
  getMultiModelContinuationStorageKey,
  normalizeMultiModelContinuationMode,
  setMultiModelContinuationMode,
  useMultiModelContinuationMode,
} from '../multiModelContinuation';

describe('multi-model continuation preference', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults missing and invalid values to selected mode', () => {
    expect(getMultiModelContinuationMode('conv-1')).toBe('selected');
    localStorage.setItem(getMultiModelContinuationStorageKey('conv-1'), 'invalid');

    expect(getMultiModelContinuationMode('conv-1')).toBe('selected');
    expect(normalizeMultiModelContinuationMode('per_model')).toBe('per_model');
  });

  it('keeps hook consumers for the same conversation synchronized', () => {
    const first = renderHook(() => useMultiModelContinuationMode('conv-1'));
    const second = renderHook(() => useMultiModelContinuationMode('conv-1'));

    act(() => first.result.current[1]('per_model'));

    expect(first.result.current[0]).toBe('per_model');
    expect(second.result.current[0]).toBe('per_model');
    expect(localStorage.getItem(getMultiModelContinuationStorageKey('conv-1'))).toBe('per_model');
  });

  it('scopes the persisted mode to its conversation', () => {
    setMultiModelContinuationMode('conv-1', 'per_model');

    expect(getMultiModelContinuationMode('conv-1')).toBe('per_model');
    expect(getMultiModelContinuationMode('conv-2')).toBe('selected');
  });

  it('falls back to selected mode when storage cannot be read', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    expect(getMultiModelContinuationMode('conv-1')).toBe('selected');
    expect(warning).toHaveBeenCalledWith(
      '[multiModelContinuation] failed to read preference:',
      expect.any(Error),
    );
  });

  it('keeps the selected snapshot when storage cannot persist a change', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    const hook = renderHook(() => useMultiModelContinuationMode('conv-1'));

    act(() => hook.result.current[1]('per_model'));

    expect(hook.result.current[0]).toBe('selected');
    expect(warning).toHaveBeenCalledWith(
      '[multiModelContinuation] failed to persist preference:',
      expect.any(Error),
    );
  });
});
