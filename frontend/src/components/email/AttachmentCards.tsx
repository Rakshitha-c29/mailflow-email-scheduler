import type { AttachmentMeta } from '../../lib/emails';
import { FileCard } from './FileCard';

const isImage = (a: AttachmentMeta) => a.contentType.startsWith('image/');

/**
 * Email detail attachments. Images preview from the (sandboxed) download route and open
 * in a new tab; other files always download (?download), never render in the browser.
 */
export function AttachmentCards({ emailId, attachments }: { emailId: string; attachments: AttachmentMeta[] }) {
  if (!attachments.length) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-4" aria-label="Attachments">
      {attachments.map((a) => {
        const url = `/api/emails/${emailId}/attachments/${a.id}`;
        return (
          <li key={a.id}>
            <FileCard
              name={a.filename}
              size={a.size}
              previewUrl={isImage(a) ? url : undefined}
              href={isImage(a) ? url : `${url}?download`}
              download={isImage(a) ? undefined : a.filename}
            />
          </li>
        );
      })}
    </ul>
  );
}
