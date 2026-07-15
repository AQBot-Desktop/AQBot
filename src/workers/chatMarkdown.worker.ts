/// <reference lib="webworker" />

import { parseChatMarkdown } from '@/lib/chatMarkdown';

type ParseRequest = { type: 'parse'; id: number; content: string };
self.addEventListener('message', (event: MessageEvent<ParseRequest>) => {
  const { id, content } = event.data;
  try {
    const nodes = parseChatMarkdown(content);
    self.postMessage({ type: 'result', id, nodes });
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

export {};
