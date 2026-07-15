import type { ChatMarkdownNode } from './chatMarkdown';

type WorkerResponse =
  | { type: 'result'; id: number; nodes: ChatMarkdownNode[] }
  | { type: 'error'; id: number; error: string };

interface PendingParse {
  content: string;
  resolve: (nodes: ChatMarkdownNode[]) => void;
  reject: (error: Error) => void;
  removeAbortListener: () => void;
}

let worker: Worker | null = null;
let nextRequestId = 1;
let activeRequestId: number | null = null;
const pending = new Map<number, PendingParse>();

function failPending(error: Error) {
  for (const task of pending.values()) {
    task.removeAbortListener();
    task.reject(error);
  }
  pending.clear();
  activeRequestId = null;
}

function failWorker(error: Error, expectedWorker?: Worker) {
  if (expectedWorker && worker !== expectedWorker) return;
  const currentWorker = worker;
  worker = null;
  currentWorker?.terminate();
  failPending(error);
}

function pumpQueue() {
  if (activeRequestId !== null || pending.size === 0) return;
  const next = pending.entries().next().value as [number, PendingParse] | undefined;
  if (!next) return;
  const [id, task] = next;
  let parserWorker: Worker;
  try {
    parserWorker = getWorker();
  } catch (cause) {
    pending.delete(id);
    task.removeAbortListener();
    task.reject(cause instanceof Error ? cause : new Error(String(cause)));
    pumpQueue();
    return;
  }
  activeRequestId = id;
  parserWorker.postMessage({ type: 'parse', id, content: task.content });
}

function getWorker(): Worker {
  if (worker) return worker;
  if (typeof Worker === 'undefined') {
    throw new Error('Markdown worker is unavailable in this environment');
  }

  const createdWorker = new Worker(new URL('../workers/chatMarkdown.worker.ts', import.meta.url), { type: 'module' });
  worker = createdWorker;
  createdWorker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
    const task = pending.get(event.data.id);
    if (!task) return;
    pending.delete(event.data.id);
    if (activeRequestId === event.data.id) activeRequestId = null;
    task.removeAbortListener();
    if (event.data.type === 'error') {
      task.reject(new Error(event.data.error));
      pumpQueue();
      return;
    }
    task.resolve(event.data.nodes);
    pumpQueue();
  });
  createdWorker.addEventListener('error', (event) => {
    const error = new Error(event.message || 'Markdown worker failed');
    failWorker(error, createdWorker);
  });
  return createdWorker;
}

export function parseChatMarkdownOffMainThread(
  content: string,
  signal?: AbortSignal,
): Promise<ChatMarkdownNode[]> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Markdown parse aborted', 'AbortError'));
  }

  const id = nextRequestId;
  nextRequestId += 1;
  return new Promise((resolve, reject) => {
    const abort = () => {
      const task = pending.get(id);
      if (!task) return;
      pending.delete(id);
      task.removeAbortListener();
      const error = new DOMException('Markdown parse aborted', 'AbortError');
      if (activeRequestId === id) {
        const currentWorker = worker;
        worker = null;
        activeRequestId = null;
        currentWorker?.terminate();
      }
      task.reject(error);
      pumpQueue();
    };
    signal?.addEventListener('abort', abort, { once: true });
    pending.set(id, {
      content,
      resolve,
      reject,
      removeAbortListener: () => signal?.removeEventListener('abort', abort),
    });
    pumpQueue();
  });
}
