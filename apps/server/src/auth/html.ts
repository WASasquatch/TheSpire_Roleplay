import sanitizeHtml from "sanitize-html";

const ALLOWED_TAGS = [
  "b", "i", "u", "em", "strong", "br", "p", "span", "a", "img",
  "ul", "ol", "li", "blockquote", "hr",
  "h3", "h4", "h5", "h6",
  "code", "pre", "small", "sub", "sup",
];

/** Sanitize a profile/bio HTML body. Used on save AND on read. */
export function sanitizeBio(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt", "title", "width", "height"],
      span: ["style"],
      "*": ["class"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["http", "https"] },
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", {
        rel: "noopener noreferrer ugc",
        target: "_blank",
      }),
    },
    allowedStyles: {
      "*": {
        color: [/^#(?:[0-9a-fA-F]{3}){1,2}$/, /^rgb\(/, /^rgba\(/],
        "font-weight": [/^bold$|^[1-9]00$/],
        "font-style": [/^italic$|^normal$/],
        "text-decoration": [/^underline$|^line-through$|^none$/],
      },
    },
    disallowedTagsMode: "discard",
  });
}
