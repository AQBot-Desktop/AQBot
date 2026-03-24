export function getStreamingLoadingState(
  isStreaming: boolean,
  content: unknown,
): { bubbleLoading: boolean; footerLoading: boolean } {
  const hasContent = typeof content === 'string'
    ? content.trim().length > 0
    : Boolean(content);

  return {
    bubbleLoading: isStreaming && !hasContent,
    footerLoading: isStreaming && hasContent,
  };
}
