import { Extension } from '@tiptap/core';

const TYPES = ['paragraph'];

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    paragraphLineHeight: {
      /** `null` resets to the default spacing. */
      setParagraphLineHeight: (value: string | null) => ReturnType;
    };
  }
}

/** Paragraph line spacing as an inline `line-height` (email-client safe). */
export const ParagraphLineHeight = Extension.create({
  name: 'paragraphLineHeight',

  addGlobalAttributes() {
    return [{
      types: TYPES,
      attributes: {
        lineHeight: {
          default: null,
          parseHTML: (el) => el.style.lineHeight || null,
          renderHTML: (attrs) => (attrs.lineHeight ? { style: `line-height: ${attrs.lineHeight}` } : {}),
        },
      },
    }];
  },

  addCommands() {
    return {
      setParagraphLineHeight: (value) => ({ commands }) =>
        TYPES.map((t) => commands.updateAttributes(t, { lineHeight: value })).some(Boolean),
    };
  },
});
