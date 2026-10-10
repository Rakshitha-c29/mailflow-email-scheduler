import { useMemo } from 'react';
import DOMPurify from 'dompurify';

/**
 * Email bodies are user-supplied HTML: sanitize before rendering (scripts, event
 * handlers, javascript: URLs, forms and <style> are removed), and open links in a new
 * tab without giving the target page a handle on ours.
 */
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  }
});

const SANITIZE = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe'],
};

const looksLikeHtml = (s: string) => /<\/?[a-z][\s\S]*>/i.test(s);

export function EmailBody({ body }: { body: string }) {
  const html = useMemo(() => (looksLikeHtml(body) ? DOMPurify.sanitize(body, SANITIZE) : null), [body]);

  if (html !== null) {
    // eslint-disable-next-line react/no-danger -- sanitized above
    return <div className="email-body" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  // Plain text: blank lines separate paragraphs, single newlines are kept.
  return (
    <div className="email-body">
      {body.split(/\n\s*\n/).map((para, i) => <p key={i} className="whitespace-pre-line">{para}</p>)}
    </div>
  );
}
