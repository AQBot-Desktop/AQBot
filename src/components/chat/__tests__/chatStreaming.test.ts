import { describe, expect, it } from 'vitest';
import { getStreamingLoadingState } from '../chatStreaming';

describe('getStreamingLoadingState', () => {
  it('keeps the bubble in loading mode before the first token arrives', () => {
    expect(getStreamingLoadingState(true, '')).toEqual({
      bubbleLoading: true,
      footerLoading: false,
    });
  });

  it('moves the loading indicator to the footer after content starts streaming', () => {
    expect(getStreamingLoadingState(true, 'hello')).toEqual({
      bubbleLoading: false,
      footerLoading: true,
    });
  });

  it('shows no loading indicators once streaming is finished', () => {
    expect(getStreamingLoadingState(false, 'done')).toEqual({
      bubbleLoading: false,
      footerLoading: false,
    });
  });
});
