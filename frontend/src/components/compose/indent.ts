import { Extension } from '@tiptap/core';

const STEP_PX = 40;
const MAX_LEVEL = 8;
const TYPES = ['paragraph', 'heading'];

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    indent: {
      indent: () => ReturnType;
      outdent: () => ReturnType;
    };
  }
}

/**
 * Indent / outdent. Inside a list it nests or un-nests the list item; elsewhere it
 * indents the paragraph with an inline `margin-left`, which email clients render.
 */
export const Indent = Extension.create({
  name: 'indent',

  addGlobalAttributes() {
    return [{
      types: TYPES,
      attributes: {
        indent: {
          default: 0,
          parseHTML: (el) => Math.min(MAX_LEVEL, Math.round((parseInt(el.style.marginLeft, 10) || 0) / STEP_PX)),
          renderHTML: (attrs) => (attrs.indent ? { style: `margin-left: ${attrs.indent * STEP_PX}px` } : {}),
        },
      },
    }];
  },

  addCommands() {
    const shift = (delta: 1 | -1) => () => ({ editor, state, tr, dispatch, commands }: any) => {
      if (editor.isActive('listItem')) {
        return delta > 0 ? commands.sinkListItem('listItem') : commands.liftListItem('listItem');
      }
      let changed = false;
      state.doc.nodesBetween(state.selection.from, state.selection.to, (node: any, pos: number) => {
        if (!TYPES.includes(node.type.name)) return true;
        const next = Math.max(0, Math.min(MAX_LEVEL, (node.attrs.indent ?? 0) + delta));
        if (next !== node.attrs.indent) {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next });
          changed = true;
        }
        return false;
      });
      if (changed && dispatch) dispatch(tr);
      return changed;
    };
    return { indent: shift(1), outdent: shift(-1) };
  },

  addKeyboardShortcuts() {
    return {
      Tab: () => this.editor.commands.indent(),
      'Shift-Tab': () => this.editor.commands.outdent(),
    };
  },
});
