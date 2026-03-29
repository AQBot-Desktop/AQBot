import { Image, FileText } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { FileCategory } from '@/types';

export type { FileCategory };

export interface FileCategoryMeta {
  id: FileCategory;
  labelKey: string;
  icon: LucideIcon;
}

export const FILE_CATEGORIES: FileCategoryMeta[] = [
  { id: 'images', labelKey: 'files.images', icon: Image },
  { id: 'files', labelKey: 'files.files', icon: FileText },
];
