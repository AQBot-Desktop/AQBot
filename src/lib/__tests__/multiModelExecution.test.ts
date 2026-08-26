import { describe, expect, it } from 'vitest';
import {
  normalizeMultiModelExecutionMode,
  normalizeMultiModelSequentialInterval,
} from '../multiModelExecution';

describe('multiModelExecution', () => {
  it('defaults unknown modes to parallel', () => {
    expect(normalizeMultiModelExecutionMode('sequential')).toBe('sequential');
    expect(normalizeMultiModelExecutionMode('parallel')).toBe('parallel');
    expect(normalizeMultiModelExecutionMode(undefined)).toBe('parallel');
    expect(normalizeMultiModelExecutionMode('other')).toBe('parallel');
  });

  it('clamps sequential interval to 0..300 integers', () => {
    expect(normalizeMultiModelSequentialInterval(3)).toBe(3);
    expect(normalizeMultiModelSequentialInterval(0)).toBe(0);
    expect(normalizeMultiModelSequentialInterval(300)).toBe(300);
    expect(normalizeMultiModelSequentialInterval(-2)).toBe(0);
    expect(normalizeMultiModelSequentialInterval(301)).toBe(300);
    expect(normalizeMultiModelSequentialInterval(1.8)).toBe(1);
    expect(normalizeMultiModelSequentialInterval('12')).toBe(12);
    expect(normalizeMultiModelSequentialInterval('nope')).toBe(3);
    expect(normalizeMultiModelSequentialInterval(null)).toBe(3);
  });
});
