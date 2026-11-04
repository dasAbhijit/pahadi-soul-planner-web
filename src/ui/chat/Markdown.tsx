import type { ComponentChildren } from 'preact';

/**
 * Inline Markdown only (bold, italic, code, links), like the phone apps' chat bubbles. Everything else stays as typed.
 * The text is never turned into HTML: it is split into pieces and handed to Preact as text, which escapes it.
 * Links are only made for http and https addresses.
 */

const LINK = String.raw`\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)`;
const BOLD = String.raw`\*\*(.+?)\*\*`;
const CODE = '`([^`\\n]+)`';
const URL_ = String.raw`(https?:\/\/[^\s<>]+)`;

function build(italic: string): RegExp {
  return new RegExp([LINK, BOLD, CODE, italic, URL_].join('|'), 'g');
}

// Groups: 1 label, 2 link url, 3 bold, 4 code, 5 italic, 6 bare url.
let token: RegExp;
try {
  token = build(String.raw`(?<![\*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\*\w])`);
} catch {
  // Very old Safari has no "lookbehind": use a simpler italic rule.
  token = build(String.raw`\*([^*\s][^*\n]*?)\*`);
}

/** Returns the address only if it really is an http(s) address. */
export function safeHttpUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

export function Link(p: { href: string; children: ComponentChildren }) {
  const safe = safeHttpUrl(p.href);
  if (!safe) return <>{p.children}</>;
  return <a href={safe} target="_blank" rel="noopener noreferrer">{p.children}</a>;
}

export function InlineMarkdown(p: { text: string }) {
  const out: ComponentChildren[] = [];
  const re = new RegExp(token.source, 'g');
  let last = 0;
  let key = 0;
  for (let m = re.exec(p.text); m; m = re.exec(p.text)) {
    if (m.index > last) out.push(p.text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<Link key={key++} href={m[2]}>{m[1]}</Link>);
    else if (m[3] !== undefined) out.push(<strong key={key++}>{m[3]}</strong>);
    else if (m[4] !== undefined) out.push(<code key={key++}>{m[4]}</code>);
    else if (m[5] !== undefined) out.push(<em key={key++}>{m[5]}</em>);
    else if (m[6] !== undefined) {
      // Leave closing punctuation outside the link.
      const trimmed = m[6].replace(/[.,;:!?)\]'"]+$/, '');
      out.push(<Link key={key++} href={trimmed}>{trimmed}</Link>);
      if (trimmed.length < m[6].length) out.push(m[6].slice(trimmed.length));
    }
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < p.text.length) out.push(p.text.slice(last));
  return <>{out}</>;
}
