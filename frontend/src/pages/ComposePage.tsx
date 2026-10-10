import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronDown, Clock, Paperclip, Upload } from 'lucide-react';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Button } from '../components/ui/Button';
import { IconButton } from '../components/ui/IconButton';
import { useToast } from '../components/Toast';
import { RichTextEditor, useComposeEditor } from '../components/compose/RichTextEditor';
import { RecipientsInput, isValidEmail } from '../components/compose/RecipientsInput';
import { SendLaterPopover } from '../components/compose/SendLaterPopover';
import { AttachmentPreviews, acceptFiles } from '../components/compose/AttachmentPreviews';
import { parseLeadList } from '../components/compose/leadList';
import { ApiError } from '../lib/api';
import { useScheduleCampaign, useSenders } from '../lib/emails';
import { formatFull, formatWhen } from '../lib/format';
import { useDismiss } from '../lib/useDismiss';
import { useErrorToast } from '../lib/useErrorToast';
import { demoHint, perWindow } from '../lib/rateWindow';

type Field = 'sender' | 'recipients' | 'subject' | 'body' | 'delay' | 'hourly';
type Errors = Partial<Record<Field, string>>;

/** Server validation paths → form fields. */
const SERVER_FIELDS: Record<string, Field> = {
  senderId: 'sender', recipients: 'recipients', subject: 'subject', body: 'body', delayMs: 'delay', hourlyLimit: 'hourly',
};

const MAX_DELAY_S = 24 * 3600;
const MAX_LIST_BYTES = 5 * 1024 * 1024;

/** Design "Compose New Email". */
export function ComposePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const senders = useSenders();
  const schedule = useScheduleCampaign();
  const limits = senders.data?.limits;
  // Without the senders (and the limits that come with them) the form can't send.
  const sendersFailed = senders.isError && !senders.data;
  useErrorToast(sendersFailed, 'Couldn’t load your senders. Check your connection and try again.');

  const [senderId, setSenderId] = useState('');
  const [recipients, setRecipients] = useState<string[]>([]);
  const [subject, setSubject] = useState('');
  const [bodyEmpty, setBodyEmpty] = useState(true);
  const [delay, setDelay] = useState('');
  const [hourly, setHourly] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [sendAt, setSendAt] = useState<Date | null>(null);
  const [laterOpen, setLaterOpen] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const listInput = useRef<HTMLInputElement>(null);
  // One key per compose session: a double click or a retried request can't create two campaigns.
  const idempotencyKey = useRef(crypto.randomUUID());
  const sent = useRef(false);

  const editor = useComposeEditor((_html, empty) => {
    setBodyEmpty(empty);
    setErrors((e) => ({ ...e, body: undefined }));
  });

  useEffect(() => {
    if (!senderId && senders.data?.senders.length) setSenderId(senders.data.senders[0].id);
  }, [senders.data, senderId]);

  const invalidRecipients = recipients.filter((r) => !isValidEmail(r)).length;
  const dirty = recipients.length > 0 || subject.trim() !== '' || !bodyEmpty || files.length > 0;

  // Closing the tab with a draft asks first (the browser shows its own prompt).
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { if (!sent.current) e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const leave = useCallback(() => {
    if (location.key !== 'default') navigate(-1);
    else navigate('/dashboard');
  }, [location.key, navigate]);

  const clear = (f: Field) => setErrors((e) => ({ ...e, [f]: undefined }));

  const addFiles = (incoming: File[]) => {
    if (!limits || !incoming.length) return;
    const { kept, errors: rejected } = acceptFiles(files, incoming, limits.attachments);
    setFiles(kept);
    rejected.forEach((m) => toast.error(m));
  };

  /** "Upload List": pull recipient addresses out of a CSV/TSV/TXT lead list. */
  const importList = async (file: File | undefined) => {
    if (!file || !limits) return;
    if (!/.(csv|tsv|txt)$/i.test(file.name)) return toast.error('Upload a .csv, .tsv or .txt list of email addresses.');
    if (file.size > MAX_LIST_BYTES) return toast.error('Lists are limited to 5 MB.');
    const { emails, skipped, duplicates } = parseLeadList(await file.text());
    if (!emails.length) return toast.error(`No email addresses found in "${file.name}".`);

    const existing = new Set(recipients);
    const fresh = emails.filter((e) => !existing.has(e));
    const room = Math.max(0, limits.maxRecipients - recipients.length);
    const added = fresh.slice(0, room);
    setRecipients([...recipients, ...added]);
    clear('recipients');

    // Repeats inside the file + addresses already in the To field.
    const dupes = duplicates + emails.length - fresh.length;
    const notes = [
      skipped && `${skipped} row${skipped === 1 ? '' : 's'} without a valid address skipped`,
      dupes && `${dupes} duplicate${dupes === 1 ? '' : 's'} ignored`,
    ].filter(Boolean);
    toast.success(`Imported ${added.length.toLocaleString('en-US')} address${added.length === 1 ? '' : 'es'} from ${file.name}${notes.length ? ` (${notes.join(', ')})` : ''}`);
    if (added.length < fresh.length) {
      toast.error(`Only ${limits.maxRecipients.toLocaleString('en-US')} recipients are allowed per campaign; ${(fresh.length - added.length).toLocaleString('en-US')} were not added.`);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles([...e.dataTransfer.files]);
  };

  function validate(): Errors {
    const e: Errors = {};
    if (!senderId) e.sender = 'Choose a sender';
    const invalid = recipients.filter((r) => !isValidEmail(r));
    if (!recipients.length) e.recipients = 'Add at least one recipient';
    else if (invalid.length) e.recipients = `Fix or remove ${invalid.length} invalid address${invalid.length > 1 ? 'es' : ''}`;
    if (!subject.trim()) e.subject = 'Subject is required';
    else if (subject.trim().length > 998) e.subject = 'Subject is too long';
    if (bodyEmpty) e.body = 'Write a message';
    if (delay !== '' && !(/^\d+$/.test(delay) && Number(delay) <= MAX_DELAY_S)) e.delay = `Whole seconds, 0 to ${MAX_DELAY_S}`;
    if (hourly !== '' && !(/^\d+$/.test(hourly) && Number(hourly) >= 1 && Number(hourly) <= 100_000)) e.hourly = 'Whole number, 1 or more';
    return e;
  }

  function send() {
    if (schedule.isPending) return;
    const e = validate();
    setErrors(e);
    if (Object.values(e).some(Boolean)) {
      toast.error('Please fix the highlighted fields.');
      return;
    }
    if (sendAt && sendAt.getTime() <= Date.now()) {
      toast.error('The scheduled time has passed. Pick a new time or clear it to send now.');
      return;
    }
    schedule.mutate({
      idempotencyKey: idempotencyKey.current,
      files,
      request: {
        senderId,
        recipients,
        subject: subject.trim(),
        body: editor!.getHTML(),
        startAt: (sendAt ?? new Date()).toISOString(),
        delayMs: Number(delay || 0) * 1000,
        hourlyLimit: hourly ? Number(hourly) : limits!.maxPerHourPerSender,
      },
    }, {
      onSuccess: ({ campaign, warnings }) => {
        sent.current = true;
        const n = campaign.scheduledCount;
        toast.success(`${n.toLocaleString('en-US')} email${n === 1 ? '' : 's'} scheduled · first send ${formatWhen(campaign.firstSendAt)}`);
        warnings.forEach((w) => toast.info(w));
        navigate('/dashboard?view=scheduled', { replace: true });
      },
      onError: (err) => {
        if (err instanceof ApiError && err.code === 'VALIDATION_ERROR' && Array.isArray(err.details)) {
          const mapped: Errors = {};
          for (const d of err.details as { path: string; message: string }[]) {
            const field = SERVER_FIELDS[d.path.split('.')[0]];
            if (field) mapped[field] ??= d.message;
          }
          setErrors(mapped);
        }
        toast.error(err instanceof ApiError ? err.message : 'Couldn’t schedule the email. Please try again.');
      },
    });
  }

  const laterRef = useDismiss(laterOpen, useCallback(() => setLaterOpen(false), []));
  const accept = limits?.attachments.extensions.map((x) => `.${x}`).join(',');

  return (
    <div
      className="relative flex h-full flex-col bg-white"
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={onDrop}
    >
      <header className="flex h-[76px] shrink-0 items-center gap-2 px-4">
        <IconButton label="Back" tone="strong" onClick={() => (dirty ? setConfirmLeave(true) : leave())} className="-ml-1.5">
          <ArrowLeft className="size-5" />
        </IconButton>
        <h1 className="min-w-0 flex-1 truncate text-xl text-gray-900 sm:text-2xl">Compose New Email</h1>

        <input ref={fileInput} type="file" multiple accept={accept} aria-label="Attachment files" className="hidden" onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
        <IconButton
          label={files.length ? `Attach files (${files.length} attached)` : 'Attach files'}
          onClick={() => fileInput.current?.click()}
          disabled={!limits}
          tone={files.length > 0 ? 'brand' : 'muted'}
        >
          <Paperclip className="size-[18px]" />
          {files.length > 0 && (
            <span className="absolute -right-0.5 -bottom-0.5 flex size-3.5 items-center justify-center rounded-full bg-neutral-100 text-[9px] leading-none font-medium text-gray-600" aria-hidden="true">
              {files.length}
            </span>
          )}
        </IconButton>

        {/* Clock + Send share one anchor so the popover aligns with Send's right edge (as designed). */}
        <div ref={laterRef} className="relative flex items-center gap-2">
          <IconButton
            label={sendAt ? `Scheduled for ${sendAt.toLocaleString()}` : 'Send later'}
            onClick={() => setLaterOpen((o) => !o)}
            tone={sendAt ? 'brand' : 'muted'}
            aria-expanded={laterOpen}
          >
            <Clock className="size-[18px]" />
          </IconButton>
          {laterOpen && (
            <SendLaterPopover
              value={sendAt}
              onApply={(d) => {
                setSendAt(d);
                setLaterOpen(false);
                toast.info(d ? `Will send ${formatFull(d.toISOString())}` : 'Will send immediately');
              }}
              onClose={() => setLaterOpen(false)}
            />
          )}
          <Button size="header" className="ml-2" onClick={send} disabled={!senders.data} loading={schedule.isPending}>
            {schedule.isPending ? (sendAt ? 'Scheduling…' : 'Sending…') : sendAt ? 'Send Later' : 'Send'}
          </Button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-10 md:px-10 lg:pr-[200px] lg:pl-[200px]">
        <Row label="From" htmlFor="c-from" error={errors.sender} border={false}>
          <div className="relative inline-flex">
            <select
              id="c-from"
              value={senderId}
              onChange={(e) => { setSenderId(e.target.value); clear('sender'); }}
              disabled={!senders.data}
              className="h-8 max-w-full appearance-none truncate rounded-md bg-[#f5f5f5] pr-8 pl-2.5 text-sm text-gray-800 hover:bg-gray-200/70 focus:outline-2 focus:outline-brand"
            >
              {!senders.data && <option>{sendersFailed ? 'Couldn’t load senders' : 'Loading senders…'}</option>}
              {senders.data?.senders.map((s) => <option key={s.id} value={s.id}>{s.email}</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute top-2 right-2 size-4 text-gray-400" />
          </div>
          {sendersFailed && (
            <button type="button" onClick={() => void senders.refetch()} disabled={senders.isFetching}
              className="ml-3 text-sm font-medium text-brand hover:underline disabled:opacity-60">
              {senders.isFetching ? 'Retrying…' : 'Try again'}
            </button>
          )}
        </Row>

        <Row label="To" htmlFor="c-to" error={errors.recipients}>
          <RecipientsInput id="c-to" value={recipients} onChange={(r) => { setRecipients(r); clear('recipients'); }} invalid={Boolean(errors.recipients)} />
          <input ref={listInput} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" aria-label="Recipient list file" className="hidden" onChange={(e) => { void importList(e.target.files?.[0]); e.target.value = ''; }} />
          {/* Show the number of addresses detected (typed, pasted or uploaded). */}
          {recipients.length > 0 && (
            <span className="ml-3 shrink-0 self-start py-[20px] text-xs text-gray-500 tabular-nums" aria-live="polite">
              {recipients.length.toLocaleString('en-US')} recipient{recipients.length === 1 ? '' : 's'}
              {invalidRecipients > 0 && <span className="text-red-600"> · {invalidRecipients} invalid</span>}
            </span>
          )}
          <button
            type="button"
            onClick={() => listInput.current?.click()}
            disabled={!limits}
            title="Import recipients from a CSV, TSV or TXT file"
            className="ml-3 flex shrink-0 items-center gap-2 self-start rounded-md px-1 py-[18px] text-sm text-brand hover:text-brand-hover focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50"
          >
            <Upload className="size-4" />
            Upload List
          </button>
        </Row>

        <Row label="Subject" htmlFor="c-subject" error={errors.subject}>
          <input
            id="c-subject"
            value={subject}
            onChange={(e) => { setSubject(e.target.value); clear('subject'); }}
            placeholder="Subject"
            maxLength={998}
            aria-invalid={Boolean(errors.subject) || undefined}
            className="h-full w-full bg-transparent pl-2.5 text-sm text-gray-900 outline-none placeholder:text-gray-400"
          />
        </Row>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
          <label htmlFor="c-delay" className="text-sm text-gray-700" title="Seconds to wait between two emails">Delay between 2 emails</label>
          <NumberBox id="c-delay" value={delay} onChange={(v) => { setDelay(v); clear('delay'); }} invalid={Boolean(errors.delay)}
            title={`Seconds between emails (minimum ${Math.round((limits?.minDelayMs ?? 0) / 1000)}s)`} />
          <label htmlFor="c-hourly" className="ml-5 text-sm text-gray-700">Hourly Limit</label>
          <NumberBox id="c-hourly" value={hourly} onChange={(v) => { setHourly(v); clear('hourly'); }} invalid={Boolean(errors.hourly)}
            title={`Emails ${limits ? perWindow(limits.windowMs) : 'per hour'} per sender (maximum ${limits?.maxPerHourPerSender ?? '…'})`} />
          {limits && demoHint(limits.windowMs) && (
            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">{demoHint(limits.windowMs)}</span>
          )}
          {(errors.delay || errors.hourly) && <p className="basis-full text-xs text-red-600">{errors.delay ?? errors.hourly}</p>}
        </div>

        <div className="mt-1">
          <RichTextEditor
            editor={editor}
            isEmpty={bodyEmpty}
            invalid={Boolean(errors.body)}
          />
          {errors.body && <p className="mt-1.5 text-xs text-red-600">{errors.body}</p>}
          <AttachmentPreviews files={files} onRemove={(f) => setFiles((all) => all.filter((x) => x !== f))} />
        </div>
      </main>

      {dragging && (
        <div className="pointer-events-none absolute inset-3 z-40 flex items-center justify-center rounded-xl border-2 border-dashed border-brand bg-brand-soft/80 text-sm font-medium text-brand">
          Drop files to attach
        </div>
      )}

      <ConfirmDialog
        open={confirmLeave}
        title="Discard this email?"
        confirmLabel="Discard"
        onConfirm={() => { sent.current = true; setConfirmLeave(false); leave(); }}
        onCancel={() => setConfirmLeave(false)}
      >
        Your recipients, subject, message and attachments will be lost.
      </ConfirmDialog>
    </div>
  );
}

function Row({ label, htmlFor, error, border = true, children }: {
  label: string;
  htmlFor: string;
  error?: string;
  border?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={border ? 'border-b border-[#ecedf0]' : ''}>
      <div className="flex min-h-14 items-center">
        <label htmlFor={htmlFor} className="w-14 shrink-0 text-sm text-gray-700">{label}</label>
        {children}
      </div>
      {error && <p className="-mt-1 pb-2 pl-14 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function NumberBox({ id, value, onChange, invalid, title }: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  title: string;
}) {
  return (
    <input
      id={id}
      inputMode="numeric"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
      placeholder="00"
      title={title}
      aria-invalid={invalid || undefined}
      className={`h-[38px] w-[70px] rounded-md border bg-white px-2.5 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-brand ${invalid ? 'border-red-300' : 'border-gray-200'}`}
    />
  );
}
