import { memo, useEffect, useMemo, useState } from 'react';
import { Button, Input, Modal, Tooltip, theme } from 'antd';
import {
  ArrowUp,
  CircleAlert,
  CirclePause,
  FileText,
  ListEnd,
  Pencil,
  Trash2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AttachmentInput } from '@/types';

export type MessageQueueTrayItem = {
  id: string;
  content: string;
  attachments?: AttachmentInput[];
  status?: 'queued' | 'dispatching' | 'failed';
  error?: string | null;
};

export type MessageQueueTrayProps = {
  messages: MessageQueueTrayItem[];
  paused?: boolean;
  error?: string | null;
  onEdit: (
    messageId: string,
    patch: { content: string; attachments: AttachmentInput[] },
  ) => void | Promise<void>;
  onSendNow: (messageId: string) => void | Promise<void>;
  onDelete: (messageId: string) => void | Promise<void>;
};

type EditingDraft = {
  id: string;
  content: string;
  attachments: AttachmentInput[];
};

export const MessageQueueTray = memo(function MessageQueueTray({
  messages,
  paused = false,
  error = null,
  onEdit,
  onSendNow,
  onDelete,
}: MessageQueueTrayProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [editingDraft, setEditingDraft] = useState<EditingDraft | null>(null);
  const visibleMessages = useMemo(
    () => messages.filter((message) => message.status !== 'dispatching'),
    [messages],
  );

  useEffect(() => {
    if (editingDraft && !visibleMessages.some((message) => message.id === editingDraft.id)) {
      setEditingDraft(null);
    }
  }, [editingDraft, visibleMessages]);

  const status = useMemo(() => {
    const failedMessage = visibleMessages.find((message) => message.status === 'failed');
    if (error || failedMessage?.error || failedMessage) {
      return {
        kind: 'failed' as const,
        text: error || failedMessage?.error || t('chat.inputQueue.failed'),
      };
    }
    if (paused) {
      return { kind: 'paused' as const, text: t('chat.inputQueue.paused') };
    }
    return null;
  }, [error, paused, t, visibleMessages]);

  if (visibleMessages.length === 0) return null;

  const openEditor = (message: MessageQueueTrayItem) => {
    setEditingDraft({
      id: message.id,
      content: message.content,
      attachments: [...(message.attachments ?? [])],
    });
  };

  const saveDisabled = editingDraft !== null
    && editingDraft.content.trim().length === 0
    && editingDraft.attachments.length === 0;

  const saveEdit = () => {
    if (!editingDraft || saveDisabled) return;
    void onEdit(editingDraft.id, {
      content: editingDraft.content,
      attachments: editingDraft.attachments,
    });
    setEditingDraft(null);
  };

  return (
    <>
      <section
        aria-label={t('chat.inputQueue.label')}
        className="mx-2 mb-2 overflow-hidden"
        style={{
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: token.borderRadiusLG,
          backgroundColor: token.colorFillQuaternary,
        }}
      >
        <div
          className="flex items-center gap-2 px-3 py-1.5 text-xs"
          style={{ color: token.colorTextSecondary }}
        >
          <ListEnd size={14} aria-hidden />
          <span className="font-medium">
            {t('chat.inputQueue.count', { count: visibleMessages.length })}
          </span>
          {status && (
            <span
              role="status"
              className="ml-auto inline-flex min-w-0 items-center gap-1"
              style={{ color: status.kind === 'failed' ? token.colorError : token.colorWarning }}
            >
              {status.kind === 'failed'
                ? <CircleAlert size={13} aria-hidden />
                : <CirclePause size={13} aria-hidden />}
              <span className="truncate" title={status.text}>{status.text}</span>
            </span>
          )}
        </div>

        <div className="flex flex-col">
          {visibleMessages.map((message) => {
            const attachmentNames = (message.attachments ?? [])
              .map((attachment) => attachment.file_name)
              .join(', ');
            return (
              <div
                key={message.id}
                data-testid={`queued-message-${message.id}`}
                className="flex items-center gap-2 border-t px-3 py-2"
                style={{ borderColor: token.colorBorderSecondary }}
              >
                <ListEnd
                  size={14}
                  aria-hidden
                  style={{ color: token.colorTextTertiary, flexShrink: 0 }}
                />
                <div className="min-w-0 flex-1">
                  <div
                    className="truncate text-sm"
                    title={message.content}
                    style={{ color: token.colorText }}
                  >
                    {message.content}
                  </div>
                  {attachmentNames && (
                    <div className="truncate text-xs" style={{ color: token.colorTextTertiary }}>
                      {t('chat.inputQueue.attachmentSummary', {
                        count: message.attachments?.length ?? 0,
                        names: attachmentNames,
                      })}
                    </div>
                  )}
                </div>
                <Tooltip title={t('chat.inputQueue.edit')}>
                  <Button
                    type="text"
                    size="small"
                    icon={<Pencil size={14} />}
                    aria-label={t('chat.inputQueue.edit')}
                    onClick={() => openEditor(message)}
                  />
                </Tooltip>
                <Tooltip title={t('chat.inputQueue.sendNowHint')}>
                  <Button
                    type="text"
                    size="small"
                    icon={<ArrowUp size={14} />}
                    aria-label={t('chat.inputQueue.sendNow')}
                    onClick={() => { void onSendNow(message.id); }}
                  />
                </Tooltip>
                <Tooltip title={t('chat.inputQueue.delete')}>
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<Trash2 size={14} />}
                    aria-label={t('chat.inputQueue.delete')}
                    onClick={() => { void onDelete(message.id); }}
                  />
                </Tooltip>
              </div>
            );
          })}
        </div>
      </section>

      <Modal
        open={editingDraft !== null}
        title={t('chat.inputQueue.editTitle')}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        okButtonProps={{ disabled: saveDisabled }}
        onOk={saveEdit}
        onCancel={() => setEditingDraft(null)}
        destroyOnHidden
      >
        {editingDraft && (
          <div className="flex flex-col gap-3">
            <Input.TextArea
              aria-label={t('chat.inputQueue.contentLabel')}
              value={editingDraft.content}
              onChange={(event) => setEditingDraft((current) => (
                current ? { ...current, content: event.target.value } : current
              ))}
              autoSize={{ minRows: 3, maxRows: 10 }}
            />
            {editingDraft.attachments.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium" style={{ color: token.colorTextSecondary }}>
                  {t('chat.inputQueue.attachments')}
                </span>
                {editingDraft.attachments.map((attachment, index) => (
                  <div
                    key={`${attachment.file_name}-${index}`}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm"
                    style={{ backgroundColor: token.colorFillTertiary }}
                  >
                    <FileText size={14} aria-hidden style={{ color: token.colorTextSecondary }} />
                    <span className="min-w-0 flex-1 truncate" title={attachment.file_name}>
                      {attachment.file_name}
                    </span>
                    <Button
                      type="text"
                      size="small"
                      icon={<X size={14} />}
                      aria-label={t('chat.inputQueue.removeAttachment', {
                        name: attachment.file_name,
                      })}
                      onClick={() => setEditingDraft((current) => (
                        current
                          ? {
                              ...current,
                              attachments: current.attachments.filter((_, itemIndex) => (
                                itemIndex !== index
                              )),
                            }
                          : current
                      ))}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  );
});
