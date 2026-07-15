import { useEffect, useRef, useState } from 'react';
import type { ChatMarkdownNode } from '@/lib/chatMarkdown';
import {
  createChatContentFingerprint,
  getCachedChatMarkdown,
  setCachedChatMarkdown,
} from '@/lib/chatMarkdownCache';
import { parseChatMarkdownOffMainThread } from '@/lib/chatMarkdownWorker';

interface DeferredChatMarkdownOptions {
  cacheKey: string;
  content: string;
  enabled: boolean;
  onError?: (error: Error) => void;
}

interface DeferredResult {
  signature: string;
  nodes: ChatMarkdownNode[];
}

function fallbackNodes(content: string): ChatMarkdownNode[] {
  return [{
    type: 'paragraph',
    children: [{ type: 'text', content, raw: content }],
    raw: content,
  } as ChatMarkdownNode];
}

export function useDeferredChatMarkdown({
  cacheKey,
  content,
  enabled,
  onError,
}: DeferredChatMarkdownOptions): ChatMarkdownNode[] | undefined {
  const signature = `${cacheKey}:${createChatContentFingerprint(content)}`;
  const cached = enabled ? getCachedChatMarkdown(cacheKey, content) : undefined;
  const [result, setResult] = useState<DeferredResult | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    if (!enabled || cached) return undefined;
    const controller = new AbortController();

    void parseChatMarkdownOffMainThread(content, controller.signal)
      .then((nodes) => {
        setCachedChatMarkdown(cacheKey, content, nodes);
        setResult({ signature, nodes });
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        const nodes = fallbackNodes(content);
        setCachedChatMarkdown(cacheKey, content, nodes);
        setResult({ signature, nodes });
        onErrorRef.current?.(error);
      });

    return () => controller.abort();
  }, [cacheKey, cached, content, enabled, signature]);

  if (!enabled) return undefined;
  return cached ?? (result?.signature === signature ? result.nodes : undefined);
}
