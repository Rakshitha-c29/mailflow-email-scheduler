import { useCallback, useState, type ReactNode } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import { FontSize, TextStyle } from '@tiptap/extension-text-style';
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, AlignStartVertical, Bold, ChevronsUpDown,
  IndentDecrease, IndentIncrease, Italic, List, ListOrdered, Quote, Redo2, Strikethrough, Underline, Undo2,
  type LucideIcon,
} from 'lucide-react';
import { Indent } from './indent';
import { ParagraphLineHeight } from './lineHeight';
import { useDismiss } from '../../lib/useDismiss';

/** Output is plain HTML with inline styles only (what email clients render reliably). */
export function useComposeEditor(onChange: (html: string, isEmpty: boolean) => void) {
  return useEditor({
    extensions: [
      StarterKit.configure({ heading: false, code: false, codeBlock: false, horizontalRule: false, link: { openOnClick: false, autolink: true } }),
      TextStyle,
      FontSize,
      TextAlign.configure({ types: ['paragraph'] }),
      Indent,
      ParagraphLineHeight,
    ],
    editorProps: {
      attributes: { class: 'email-body compose-editor', 'aria-label': 'Email body', role: 'textbox', 'aria-multiline': 'true' },
    },
    onUpdate: ({ editor }) => onChange(editor.getHTML(), editor.isEmpty),
  });
}

const SIZES = [
  { label: 'Small', value: '13px' },
  { label: 'Normal', value: null },
  { label: 'Large', value: '18px' },
  { label: 'Huge', value: '24px' },
] as const;

const SPACINGS = [
  { label: 'Single', value: null },
  { label: '1.5 lines', value: '1.5' },
  { label: 'Double', value: '2' },
] as const;

/** True if any node of this type is inside the selection (not only if it wraps all of it). */
function touches(e: Editor, type: string): boolean {
  const { from, to } = e.state.selection;
  let found = false;
  e.state.doc.nodesBetween(from, to, (n) => {
    if (n.type.name === type) found = true;
    return !found;
  });
  return found;
}

/**
 * Removes one level of every quote the selection touches. (`lift` can't do this when
 * the selection spans a quote and a sibling paragraph, e.g. after Select All.)
 */
function unwrapQuotes(e: Editor): boolean {
  const { from, to } = e.state.selection;
  const quotes: { pos: number; size: number; content: typeof e.state.doc.content }[] = [];
  e.state.doc.nodesBetween(from, to, (n, pos) => {
    if (n.type.name !== 'blockquote') return true;
    quotes.push({ pos, size: n.nodeSize, content: n.content });
    return false; // outermost only: one level per click
  });
  if (!quotes.length) return false;
  const tr = e.state.tr;
  for (const q of quotes.reverse()) tr.replaceWith(q.pos, q.pos + q.size, q.content);
  e.view.dispatch(tr);
  e.commands.focus();
  return true;
}

/** The design's "Tт" text-size glyph (big T + small T), drawn like a Lucide icon. */
function TextSizeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" aria-hidden="true">
      <path d="M3 6h10M8 6v13M14 11h7M17.5 11v8" />
    </svg>
  );
}

const ALIGNMENTS: { label: string; value: 'left' | 'center' | 'right' | 'justify'; icon: LucideIcon }[] = [
  { label: 'Align left', value: 'left', icon: AlignLeft },
  { label: 'Align center', value: 'center', icon: AlignCenter },
  { label: 'Align right', value: 'right', icon: AlignRight },
  { label: 'Justify', value: 'justify', icon: AlignJustify },
];

/** Design "Compose": grey box → caption → white toolbar → writing area. */
export function RichTextEditor({ editor, isEmpty, invalid }: {
  editor: Editor | null;
  isEmpty: boolean;
  invalid?: boolean;
}) {
  return (
    <div
      className={`flex min-h-[480px] flex-col rounded-lg bg-neutral-50 px-4 pt-3 pb-4 ${invalid ? 'outline-2 outline-red-300' : ''}`}
      onMouseDown={(e) => {
        // Clicking the empty grey area focuses the editor (like a big text field).
        if (e.target === e.currentTarget) { e.preventDefault(); editor?.commands.focus('end'); }
      }}
    >
      <p className={`mb-5 text-sm text-gray-400 ${isEmpty ? '' : 'invisible'}`} aria-hidden="true">Type Your Reply...</p>
      {editor && <Toolbar editor={editor} />}
      <div className="mt-3 flex-1 cursor-text px-1" onClick={() => editor?.commands.focus()}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  // Re-render only when the formatting state under the cursor changes.
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      ordered: e.isActive('orderedList'),
      bullet: e.isActive('bulletList'),
      // Select-all also covers the trailing empty paragraph, so "active" alone misses it.
      quote: touches(e, 'blockquote'),
      lineHeight: (e.getAttributes('paragraph').lineHeight as string | null) ?? null,
      fontSize: (e.getAttributes('textStyle').fontSize as string | undefined) ?? null,
      align: (ALIGNMENTS.find((a) => e.isActive({ textAlign: a.value }))?.value ?? 'left') as string,
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
      canIndent: e.can().indent(),
      canOutdent: e.can().outdent(),
    }),
  });
  const run = (fn: (c: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => () => fn(editor.chain().focus()).run();
  const AlignIcon = ALIGNMENTS.find((a) => a.value === s.align)?.icon ?? AlignLeft;

  return (
    <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-1 rounded-lg bg-white px-2 py-0.5">
      <Btn icon={Undo2} label="Undo" onClick={run((c) => c.undo())} disabled={!s.canUndo} />
      <Btn icon={Redo2} label="Redo" onClick={run((c) => c.redo())} disabled={!s.canRedo} />
      <Divider />
      <Menu
        label="Text size"
        wide
        trigger={<><TextSizeIcon className="size-[18px]" /><ChevronsUpDown className="size-3" /></>}
        items={SIZES.map((o) => ({
          key: o.label,
          label: <span style={{ fontSize: o.value ?? '15px' }}>{o.label}</span>,
          active: s.fontSize === o.value,
          onSelect: run((c) => (o.value ? c.setFontSize(o.value) : c.unsetFontSize())),
        }))}
      />
      <Divider />
      <Btn icon={Bold} label="Bold" shortcut="Ctrl+B" onClick={run((c) => c.toggleBold())} active={s.bold} />
      <Btn icon={Italic} label="Italic" shortcut="Ctrl+I" onClick={run((c) => c.toggleItalic())} active={s.italic} />
      <Btn icon={Underline} label="Underline" shortcut="Ctrl+U" onClick={run((c) => c.toggleUnderline())} active={s.underline} />
      <Divider />
      <Menu
        label="Alignment"
        trigger={<AlignIcon className="size-[18px]" />}
        items={ALIGNMENTS.map((a) => ({
          key: a.value,
          label: <span className="flex items-center gap-2"><a.icon className="size-4" />{a.label}</span>,
          active: s.align === a.value,
          onSelect: run((c) => (a.value === 'left' ? c.unsetTextAlign() : c.setTextAlign(a.value))),
        }))}
      />
      <Menu
        label="Line spacing"
        trigger={<ChevronsUpDown className="size-[18px]" />}
        items={SPACINGS.map((o) => ({
          key: o.label,
          label: o.label,
          active: s.lineHeight === o.value,
          onSelect: run((c) => c.setParagraphLineHeight(o.value)),
        }))}
      />
      <Divider />
      <Btn icon={ListOrdered} label="Numbered list" onClick={run((c) => c.toggleOrderedList())} active={s.ordered} />
      <Btn icon={List} label="Bulleted list" onClick={run((c) => c.toggleBulletList())} active={s.bullet} />
      <Btn icon={IndentIncrease} label="Indent" shortcut="Tab" onClick={run((c) => c.indent())} disabled={!s.canIndent} />
      <Btn icon={IndentDecrease} label="Outdent" shortcut="Shift+Tab" onClick={run((c) => c.outdent())} disabled={!s.canOutdent} />
      <Btn icon={Quote} label="Quote" onClick={() => (s.quote ? unwrapQuotes(editor) : editor.chain().focus().wrapIn('blockquote').run())} active={s.quote} />
      <Btn
        icon={AlignStartVertical}
        label="Clear formatting"
        onClick={run((c) => c.unsetAllMarks().clearNodes().unsetTextAlign().updateAttributes('paragraph', { indent: 0, lineHeight: null }))}
      />
      <Divider />
      <Btn icon={Strikethrough} label="Strikethrough" onClick={run((c) => c.toggleStrike())} active={s.strike} />
    </div>
  );
}

function Btn({ icon: Icon, label, shortcut, onClick, active, disabled }: {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()} // keep the editor's selection
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={`flex size-9 items-center justify-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-35 ${
        active ? 'bg-brand-soft text-brand' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-800'
      }`}
    >
      <Icon className="size-[18px]" strokeWidth={1.75} />
    </button>
  );
}

function Divider() {
  return <span className="mx-1.5 h-5 w-px bg-gray-200" aria-hidden="true" />;
}

function Menu({ label, trigger, items, wide }: {
  label: string;
  wide?: boolean;
  trigger: ReactNode;
  items: { key: string; label: ReactNode; active: boolean; onSelect: () => void }[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, useCallback(() => setOpen(false), []));
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        className={`flex h-9 min-w-9 items-center justify-center rounded-md text-gray-500 ${wide ? 'gap-1 px-2.5' : 'gap-0.5 px-1.5'} hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-2 focus-visible:outline-brand`}
      >
        {trigger}
      </button>
      {open && (
        <div role="menu" aria-label={label} className="absolute top-full left-0 z-20 mt-1 min-w-36 rounded-lg border border-line bg-white p-1 shadow-lg">
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitemradio"
              aria-checked={it.active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { it.onSelect(); setOpen(false); }}
              className={`flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-field ${it.active ? 'font-medium text-brand' : 'text-gray-700'}`}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
