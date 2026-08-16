import sanitizeHtml from 'sanitize-html';

/**
 * Rich-text fields are written by the admin TipTap editor and rendered on the
 * public site through `dangerouslySetInnerHTML`. Sanitising on WRITE (here) means
 * the database can never hold a stored-XSS payload, so every consumer of the API
 * is safe without having to remember to sanitise on read.
 *
 * The allowlist matches what the existing content actually uses (<b>, <br>, <ol>,
 * <li>) plus the formatting the editor toolbar can produce.
 */
const options: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'b', 'strong', 'i', 'em', 'u', 's',
    'h2', 'h3', 'h4',
    'ul', 'ol', 'li',
    'blockquote', 'a', 'span',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    span: ['style'],
  },
  // Block javascript:, data: and other exotic schemes on links.
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesAppliedToAttributes: ['href'],
  // Only allow inline styles that cannot be used to overlay or hide content.
  allowedStyles: {
    span: {
      'text-align': [/^left$|^right$|^center$|^justify$/],
    },
  },
  transformTags: {
    // Any external link opened in a new tab must not leak window.opener.
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }, true),
  },
};

export function sanitizeRichText(html: string): string {
  return sanitizeHtml(html, options);
}

/**
 * Strips ALL markup. Used for plain-text columns (shortDes, meta descriptions)
 * so a paste from Word cannot smuggle tags into a field the site renders raw.
 */
export function stripHtml(input: string): string {
  return sanitizeHtml(input, { allowedTags: [], allowedAttributes: {} }).trim();
}
