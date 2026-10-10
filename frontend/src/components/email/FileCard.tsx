import { X } from 'lucide-react';
import { formatBytes } from '../../lib/format';
import { fileIcon } from '../../lib/files';

/**
 * Attachment card from the designs (email detail + compose): preview on top, name and
 * size below. Pass `href` to make it a link, `onRemove` to show a remove button.
 */
export function FileCard({ name, size, previewUrl, href, download, onRemove }: {
  name: string;
  size: number;
  previewUrl?: string;
  href?: string;
  download?: string;
  onRemove?: () => void;
}) {
  const Icon = fileIcon(name);
  const body = (
    <>
      <div className="flex h-[118px] items-center justify-center overflow-hidden bg-gray-100">
        {previewUrl
          ? <img src={previewUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
          : <Icon className="size-10 text-gray-400" strokeWidth={1.25} />}
      </div>
      <div className="px-2.5 py-2">
        <p className="truncate text-xs font-medium text-gray-900">{name}</p>
        <p className="mt-0.5 text-[10px] text-gray-400">{formatBytes(size)}</p>
      </div>
    </>
  );
  const card = 'block w-[210px] overflow-hidden rounded-lg border border-gray-100 bg-gray-50';
  return (
    <div className="group relative" title={`${name} (${formatBytes(size)})`}>
      {href ? (
        <a
          href={href}
          target={download ? undefined : '_blank'}
          rel="noopener noreferrer"
          download={download}
          className={`${card} transition-shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-brand`}
        >
          {body}
        </a>
      ) : (
        <div className={card}>{body}</div>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          className="absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-full bg-white/90 text-gray-600 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 hover:text-gray-900 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-brand"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
