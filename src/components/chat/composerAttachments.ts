import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent } from 'react';
import type { AttachmentInput } from '@/types';
import {
  createComposerAttachment,
  revokeComposerAttachment,
  revokeComposerAttachments,
  type ComposerAttachment,
} from './AttachmentChips';
import { getAttachmentMimeType, isImageAttachmentFile } from './attachmentFileTypes';

export { getAttachmentMimeType } from './attachmentFileTypes';

export const DOCUMENT_ATTACHMENT_ACCEPT = [
  '.pdf',
  '.doc',
  '.docx',
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.json',
  '.html',
  '.htm',
  '.xml',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'text/html',
  'text/xml',
  'application/xml',
].join(',');

const DOCUMENT_ATTACHMENT_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'text/html',
  'application/xml',
]);

export function isAllowedChatAttachmentFile(
  file: Pick<File, 'name' | 'type'>,
  hasVision: boolean,
  documentAttachmentReadingEnabled: boolean,
): boolean {
  const effectiveMimeType = getAttachmentMimeType(file.name, file.type);
  if (hasVision && isImageAttachmentFile(file)) return true;
  if (!documentAttachmentReadingEnabled) return false;
  return DOCUMENT_ATTACHMENT_MIME_TYPES.has(effectiveMimeType.toLowerCase());
}

export function isAllowedAcpAttachmentFile(
  file: Pick<File, 'name' | 'type'>,
  supportsImages: boolean,
): boolean {
  return supportsImages || !isImageAttachmentFile(file);
}

export async function fileToAttachmentInput(file: File): Promise<AttachmentInput> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}`));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error(`Failed to read ${file.name}`));
        return;
      }
      resolve({
        file_name: file.name,
        file_type: getAttachmentMimeType(file.name, file.type),
        file_size: file.size,
        data: result.split(',')[1] || '',
      });
    };
    reader.readAsDataURL(file);
  });
}

function nativePathFileDescriptor(filePath: string): File {
  const fileName = filePath.split(/[\\/]/).pop() || 'file';
  return new File([], fileName, { type: getAttachmentMimeType(fileName), lastModified: 0 });
}

function dataTransferHasFiles(dataTransfer: DataTransfer | null | undefined): boolean {
  return Boolean(dataTransfer?.types.includes('Files'));
}

export function filesFromDataTransfer(dataTransfer: DataTransfer | null | undefined): File[] {
  if (!dataTransfer) return [];
  const listed = Array.from(dataTransfer.files ?? []);
  if (listed.length > 0) return listed;
  return Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

async function nativePathToFile(filePath: string, descriptor: File): Promise<File> {
  const { readFile, stat } = await import('@tauri-apps/plugin-fs');
  const bytes = await readFile(filePath);
  let lastModified = 0;
  try {
    const info = await stat(filePath);
    lastModified = info.mtime?.getTime() ?? 0;
  } catch {
    // `stat` is optional: dropped paths may lack that permission even when read succeeds.
  }
  return new File([bytes], descriptor.name, {
    type: descriptor.type,
    lastModified,
  });
}

export interface UseComposerAttachmentsOptions {
  enabled?: boolean;
  acceptFile: (file: File) => boolean;
  onRejected?: (files: File[]) => void;
  onReadError?: (filePath: string, error: unknown) => void;
}

function attachmentDedupeKey(file: File): string {
  return `${file.name}:${file.size}:${getAttachmentMimeType(file.name, file.type).toLowerCase()}`;
}

export function useComposerAttachments({
  enabled = true,
  acceptFile,
  onRejected,
  onReadError,
}: UseComposerAttachmentsOptions) {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const htmlDragDepthRef = useRef(0);
  const connectedRef = useRef(false);

  useEffect(() => {
    connectedRef.current = true;
    return () => {
      connectedRef.current = false;
      revokeComposerAttachments(attachmentsRef.current);
      attachmentsRef.current = [];
      htmlDragDepthRef.current = 0;
      setAttachments([]);
      setIsDragging(false);
    };
  }, []);

  const addFiles = useCallback((incoming: File[]) => {
    if (!enabled || incoming.length === 0) return;
    const accepted = incoming.filter(acceptFile);
    const rejected = incoming.filter((file) => !acceptFile(file));
    if (rejected.length > 0) onRejected?.(rejected);
    if (accepted.length === 0) return;
    setAttachments((previous) => {
      const keys = new Set(
        previous.map(({ file }) => attachmentDedupeKey(file)),
      );
      const unique = accepted
        .filter((file) => {
          const key = attachmentDedupeKey(file);
          if (keys.has(key)) return false;
          keys.add(key);
          return true;
        })
        .map((file) => createComposerAttachment(file));
      return unique.length > 0 ? [...previous, ...unique] : previous;
    });
  }, [acceptFile, enabled, onRejected]);
  const nativeDropCallbacksRef = useRef({
    acceptFile,
    addFiles,
    onReadError,
    onRejected,
  });
  nativeDropCallbacksRef.current = {
    acceptFile,
    addFiles,
    onReadError,
    onRejected,
  };

  const removeAttachment = useCallback((id: string) => {
    setAttachments((previous) => {
      const target = previous.find((item) => item.id === id);
      if (target) revokeComposerAttachment(target);
      return previous.filter((item) => item.id !== id);
    });
  }, []);

  const resetAttachments = useCallback(() => {
    revokeComposerAttachments(attachmentsRef.current);
    attachmentsRef.current = [];
    htmlDragDepthRef.current = 0;
    setIsDragging(false);
    setAttachments([]);
  }, []);

  const detachAttachments = useCallback(() => {
    const detached = attachmentsRef.current;
    attachmentsRef.current = [];
    setAttachments([]);
    return detached;
  }, []);

  const restoreAttachments = useCallback((items: ComposerAttachment[]) => {
    if (!connectedRef.current) {
      revokeComposerAttachments(items);
      return;
    }
    setAttachments((current) => {
      const currentKeys = new Set(
        current.map(({ file }) => attachmentDedupeKey(file)),
      );
      const restored = items.filter((item) => {
        if (current.includes(item)) return false;
        const key = attachmentDedupeKey(item.file);
        if (!currentKeys.has(key)) return true;
        revokeComposerAttachment(item);
        return false;
      });
      const next = restored.length > 0 ? [...restored, ...current] : current;
      attachmentsRef.current = next;
      return next;
    });
  }, []);

  const openFilePicker = useCallback(() => fileInputRef.current?.click(), []);

  const handleFileChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(event.target.files ?? []));
    event.target.value = '';
  }, [addFiles]);

  const handleClipboardFiles = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return false;
    event.preventDefault();
    if (!files.some(acceptFile)) {
      onRejected?.(files);
      return true;
    }
    addFiles(files);
    return true;
  }, [acceptFile, addFiles, onRejected]);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) => {
        if (cancelled) return undefined;
        return getCurrentWebview().onDragDropEvent(async (event) => {
          if (cancelled) return;
          if (event.payload.type === 'enter') {
            setIsDragging(true);
            return;
          }
          if (event.payload.type === 'leave') {
            htmlDragDepthRef.current = 0;
            setIsDragging(false);
            return;
          }
          if (event.payload.type !== 'drop') return;
          htmlDragDepthRef.current = 0;
          setIsDragging(false);
          const files: File[] = [];
          const rejected: File[] = [];
          for (const filePath of event.payload.paths) {
            const descriptor = nativePathFileDescriptor(filePath);
            if (!nativeDropCallbacksRef.current.acceptFile(descriptor)) {
              rejected.push(descriptor);
              continue;
            }
            try {
              files.push(await nativePathToFile(filePath, descriptor));
            } catch (error) {
              if (!cancelled) nativeDropCallbacksRef.current.onReadError?.(filePath, error);
            }
          }
          if (cancelled) return;
          if (rejected.length > 0) nativeDropCallbacksRef.current.onRejected?.(rejected);
          nativeDropCallbacksRef.current.addFiles(files);
        });
      })
      .then((nextUnlisten) => {
        if (!nextUnlisten) return;
        if (cancelled) nextUnlisten();
        else unlisten = nextUnlisten;
      })
      .catch((error) => {
        if (!cancelled) {
          console.error('[composer attachments] Failed to register native drag-and-drop listener:', error);
        }
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [enabled]);

  const handleDragEnter = useCallback((event: DragEvent) => {
    if (!enabled || !dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    htmlDragDepthRef.current += 1;
    setIsDragging(true);
  }, [enabled]);

  const handleDragOver = useCallback((event: DragEvent) => {
    if (!enabled || !dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }, [enabled]);

  const handleDragLeave = useCallback((event: DragEvent) => {
    if (!enabled) return;
    event.preventDefault();
    event.stopPropagation();
    htmlDragDepthRef.current = Math.max(0, htmlDragDepthRef.current - 1);
    if (htmlDragDepthRef.current === 0) setIsDragging(false);
  }, [enabled]);

  const handleDrop = useCallback((event: DragEvent) => {
    if (!enabled) return;
    event.preventDefault();
    event.stopPropagation();
    htmlDragDepthRef.current = 0;
    setIsDragging(false);
    addFiles(filesFromDataTransfer(event.dataTransfer));
  }, [addFiles, enabled]);

  useEffect(() => {
    if (!enabled || !isDragging || typeof window === 'undefined') return;
    const onDragOver = (event: globalThis.DragEvent) => {
      if (!dataTransferHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (event: globalThis.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      htmlDragDepthRef.current = 0;
      setIsDragging(false);
      addFiles(filesFromDataTransfer(event.dataTransfer));
    };
    window.addEventListener('dragover', onDragOver, true);
    window.addEventListener('drop', onDrop, true);
    return () => {
      window.removeEventListener('dragover', onDragOver, true);
      window.removeEventListener('drop', onDrop, true);
    };
  }, [addFiles, enabled, isDragging]);

  return {
    attachments,
    attachmentsRef,
    fileInputRef,
    isDragging,
    addFiles,
    removeAttachment,
    resetAttachments,
    detachAttachments,
    restoreAttachments,
    openFilePicker,
    handleFileChange,
    handleClipboardFiles,
    dragHandlers: {
      onDragEnter: handleDragEnter,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
  };
}
