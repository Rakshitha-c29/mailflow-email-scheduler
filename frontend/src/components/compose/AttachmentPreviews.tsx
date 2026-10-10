import { useEffect, useMemo } from 'react';
import { formatBytes } from '../../lib/format';
import { extOf, IMAGE_EXTENSIONS } from '../../lib/files';
import { FileCard } from '../email/FileCard';
import type { Limits } from '../../lib/emails';

/**
 * Checks new files against the server's limits (from /api/senders) so the user gets
 * instant feedback; the server re-validates everything, including the file contents.
 * Returns the files to keep and a message for each rejected one.
 */
export function acceptFiles(current: File[], incoming: File[], limits: Limits['attachments']) {
  const kept = [...current];
  const errors: string[] = [];
  let total = kept.reduce((n, f) => n + f.size, 0);
  for (const f of incoming) {
    if (!limits.extensions.includes(extOf(f.name))) {
      errors.push(`"${f.name}" can't be attached. Allowed: images, PDF, Word, Excel, PowerPoint, OpenDocument, TXT and CSV.`);
    } else if (f.size === 0) {
      errors.push(`"${f.name}" is empty.`);
    } else if (kept.length >= limits.maxFiles) {
      errors.push(`At most ${limits.maxFiles} attachments are allowed.`);
    } else if (total + f.size > limits.maxTotalBytes) {
      errors.push(`"${f.name}" would exceed the ${formatBytes(limits.maxTotalBytes)} attachment limit.`);
    } else if (kept.some((k) => k.name === f.name && k.size === f.size)) {
      // already attached: ignore silently
    } else {
      kept.push(f);
      total += f.size;
    }
  }
  return { kept, errors: [...new Set(errors)] };
}

/** Compose attachments as preview cards below the editor (design "Compose", filled state). */
export function AttachmentPreviews({ files, onRemove }: { files: File[]; onRemove: (f: File) => void }) {
  // Object URLs for image thumbnails, released when files change or the page closes.
  const urls = useMemo(() => new Map(files.filter((f) => IMAGE_EXTENSIONS.includes(extOf(f.name))).map((f) => [f, URL.createObjectURL(f)])), [files]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);

  if (!files.length) return null;
  return (
    <ul className="mt-4 flex flex-wrap gap-4" aria-label="Attachments">
      {files.map((f) => (
        <li key={`${f.name}-${f.size}-${f.lastModified}`}>
          <FileCard name={f.name} size={f.size} previewUrl={urls.get(f)} onRemove={() => onRemove(f)} />
        </li>
      ))}
    </ul>
  );
}
