import { FileImage, FileSpreadsheet, FileText } from 'lucide-react';

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

export const extOf = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');

export function fileIcon(name: string) {
  const ext = extOf(name);
  if (IMAGE_EXTENSIONS.includes(ext)) return FileImage;
  if (['xls', 'xlsx', 'ods', 'csv'].includes(ext)) return FileSpreadsheet;
  return FileText;
}
