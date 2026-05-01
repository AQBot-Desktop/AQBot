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

export function shouldRenderAssistantMarkdownFromContent(
  isStreaming: boolean,
  streamedInCurrentSession: boolean,
): boolean {
  return isStreaming || streamedInCurrentSession;
}

export function hasModelVisibleContent(content: unknown, stripDisplayTags: (content: string) => string): boolean {
  if (typeof content !== 'string') {
    return Boolean(content);
  }
  return stripDisplayTags(content).trim().length > 0;
}

export function hasAqbotDisplayContent(content: unknown): boolean {
  return typeof content === 'string'
    && /<(?:knowledge-retrieval|memory-retrieval|web-search)\b[^>]*data-aqbot=["']1["'][^>]*>/i.test(content);
}

const LEADING_AQBOT_DISPLAY_TAG_RE = /^\s*<(knowledge-retrieval|memory-retrieval|web-search)\b[^>]*data-aqbot=["']1["'][^>]*>[\s\S]*?<\/\1>\s*/i;

export function splitLeadingAqbotDisplayContent(content: string): { prefix: string; body: string } {
  let body = content;
  let prefix = '';

  for (;;) {
    const match = body.match(LEADING_AQBOT_DISPLAY_TAG_RE);
    if (!match) break;
    prefix += match[0];
    body = body.slice(match[0].length);
  }

  return { prefix, body };
}

export function stripLeadingAqbotDisplayTags(content: string, tagNames: string[]): string {
  const tagSet = new Set(tagNames);
  let body = content;
  let keptPrefix = '';

  for (;;) {
    const match = body.match(LEADING_AQBOT_DISPLAY_TAG_RE);
    if (!match) break;
    const tagName = match[1]?.toLowerCase();
    if (!tagName || !tagSet.has(tagName)) {
      keptPrefix += match[0];
    }
    body = body.slice(match[0].length);
  }

  return keptPrefix + body;
}
