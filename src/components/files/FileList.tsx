/** FileList renders file rows in an antd Table with built-in multi-column sorting. */

import { useCallback, useEffect, useState } from 'react';
import { Button, Empty, Image, Popconfirm, Table, Tag, theme } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { FolderOpen, Image as ImageIcon, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@/lib/invoke';
import type { FileCategory, FileRow } from '@/types';

interface FileListProps {
  rows?: FileRow[];
  category?: FileCategory;
  selectedRowKeys?: string[];
  onSelectionChange?: (keys: string[]) => void;
  onReveal?: (path: string) => void;
  onDelete?: (id: string) => void;
}

function formatSize(bytes?: number): string {
  if (bytes == null) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

/** Load base64 data URL for an image thumbnail via Rust command. */
function useThumbnailSrc(storagePath: string | undefined, missing: boolean | undefined): string | undefined {
  const [src, setSrc] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!storagePath || missing) return;
    let cancelled = false;
    invoke<string>('read_attachment_preview', { filePath: storagePath })
      .then((dataUrl) => { if (!cancelled) setSrc(dataUrl); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [storagePath, missing]);
  return src;
}

function ImageThumbnail({ record }: { record: FileRow }) {
  const { token } = theme.useToken();
  // Extract relative storage path from the full resolved path — use the row's raw storage_path if available
  const src = useThumbnailSrc(record.storagePath, record.missing);
  return (
    <div
      className="h-10 w-10 overflow-hidden rounded-md border flex items-center justify-center"
      style={{
        borderColor: token.colorBorderSecondary,
        backgroundColor: src ? token.colorBgContainer : token.colorFillQuaternary,
      }}
    >
      {src ? (
        <Image
          src={src}
          alt=""
          width={40}
          height={40}
          style={{ objectFit: 'cover' }}
          preview={{ mask: { blur: true }, scaleStep: 0.5 }}
        />
      ) : (
        <ImageIcon size={16} style={{ color: token.colorTextSecondary }} />
      )}
    </div>
  );
}

export function FileList({ rows = [], category, selectedRowKeys = [], onSelectionChange, onReveal, onDelete }: FileListProps) {
  const { token } = theme.useToken();
  const { t } = useTranslation();
  const showThumbnails = category === 'images';

  const columns: ColumnsType<FileRow> = [];

  if (showThumbnails) {
    columns.push({
      title: '',
      key: 'thumbnail',
      width: 56,
      render: (_: unknown, record: FileRow) => <ImageThumbnail record={record} />,
    });
  }

  columns.push(
    {
      title: t('files.columnName'),
      dataIndex: 'name',
      key: 'name',
      sorter: { compare: (a, b) => a.name.localeCompare(b.name), multiple: 1 },
      ellipsis: true,
      render: (name: string) => (
        <span className="text-sm font-medium" title={name}>{name}</span>
      ),
    },
    {
      title: t('files.columnSize'),
      dataIndex: 'size',
      key: 'size',
      width: 100,
      sorter: { compare: (a, b) => (a.size ?? 0) - (b.size ?? 0), multiple: 2 },
      render: (size: number | undefined) => (
        <span className="text-xs" style={{ color: token.colorTextSecondary }}>{formatSize(size)}</span>
      ),
    },
    {
      title: t('files.columnCreatedAt'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      sorter: { compare: (a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''), multiple: 3 },
      defaultSortOrder: 'descend',
      render: (date: string | undefined) => (
        <span className="text-xs" style={{ color: token.colorTextSecondary }}>{date ?? '—'}</span>
      ),
    },
    {
      title: t('files.columnActions'),
      key: 'actions',
      width: 160,
      render: (_: unknown, record: FileRow) => {
        if (record.missing) {
          return (
            <span className="flex items-center gap-1">
              <Tag color="error" bordered={false}>{t('files.missing')}</Tag>
              {onDelete && (
                <Popconfirm
                  title={t('files.deleteConfirm')}
                  onConfirm={() => onDelete(record.id)}
                  okText={t('files.confirmYes')}
                  cancelText={t('files.confirmNo')}
                >
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<Trash2 size={14} />}
                    aria-label={`${t('files.delete')} ${record.name}`}
                  >
                    {t('files.delete')}
                  </Button>
                </Popconfirm>
              )}
            </span>
          );
        }
        return (
          <span className="flex items-center gap-1">
            {onReveal && record.path && (
              <Button
                type="text"
                size="small"
                icon={<FolderOpen size={14} />}
                onClick={() => onReveal(record.path)}
                aria-label={`${t('files.open')} ${record.name}`}
              >
                {t('files.open')}
              </Button>
            )}
            {onDelete && (
              <Popconfirm
                title={t('files.deleteConfirm')}
                onConfirm={() => onDelete(record.id)}
                okText={t('files.confirmYes')}
                cancelText={t('files.confirmNo')}
              >
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<Trash2 size={14} />}
                  aria-label={`${t('files.delete')} ${record.name}`}
                >
                  {t('files.delete')}
                </Button>
              </Popconfirm>
            )}
          </span>
        );
      },
    },
  );

  const handleSelectionChange = useCallback(
    (keys: React.Key[]) => { onSelectionChange?.(keys as string[]); },
    [onSelectionChange],
  );

  return (
    <Table<FileRow>
      dataSource={rows}
      columns={columns}
      rowKey="id"
      size="small"
      rowSelection={{
        selectedRowKeys,
        onChange: handleSelectionChange,
      }}
      pagination={{
        defaultPageSize: 15,
        showSizeChanger: true,
        pageSizeOptions: ['15', '30', '50'],
        showTotal: (total) => t('files.totalItems', { total }),
      }}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('files.empty')} /> }}
    />
  );
}
