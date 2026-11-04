/** Turns an assistant reply (Markdown) into WhatsApp formatting and builds a wa.me link that opens WhatsApp with the text pre-filled. */

const MARKER = '\u0001'; // temporary stand-in for WhatsApp's *bold* asterisk

const heading = /^\s{0,3}#{1,6}\s+/;
const bullet = /^\s*[*-]\s+/;
const bold = /\*\*(.+?)\*\*/g;
const link = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
const blankRuns = /\n{3,}/g;

// Needs "lookbehind", which very old Safari lacks. Without it the italics are simply left as they were.
let italic: RegExp | null = null;
try { italic = new RegExp('(?<![\\*\\w])\\*(?!\\s)([^*\\n]+?)(?<!\\s)\\*(?![\\*\\w])', 'g'); } catch { italic = null; }

export function formatForWhatsApp(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n').map((line) => {
    const h = heading.exec(line);
    if (h) {
      const title = line.slice(h[0].length).trim();
      return title === '' ? '' : `${MARKER}${title}${MARKER}`;
    }
    const b = bullet.exec(line);
    if (b) return '• ' + line.slice(b[0].length);
    return line;
  });
  let text = lines.join('\n');
  text = text.replace(bold, (_m, g: string) => `${MARKER}${g}${MARKER}`); // **bold** -> *bold*
  if (italic) text = text.replace(italic, (_m, g: string) => `_${g}_`); // *italic* -> _italic_
  text = text.replace(link, (_m, label: string, url: string) => `${label} (${url})`); // [label](url) -> label (url)
  text = text.split(MARKER).join('*');
  text = text.replace(blankRuns, '\n\n');
  return text.trim();
}

/** Encodes everything except letters, digits and - . _ ~ (spaces become %20, as WhatsApp expects). */
function percentEncode(text: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(text)) {
    const ch = String.fromCharCode(byte);
    if (byte < 128 && /[A-Za-z0-9\-._~]/.test(ch)) out += ch;
    else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

export const whatsAppUrl = (markdown: string): string => 'https://wa.me/?text=' + percentEncode(formatForWhatsApp(markdown));

export interface QuickPrompt { id: string; title: string; text: string }

/** One-tap messages shown above the chat box. */
export const QUICK_PROMPTS: QuickPrompt[] = [
  { id: 'pitch', title: 'Pitch next upcoming trek', text: 'Pitch our next upcoming trek for this client in a short, friendly message.' },
  { id: 'first-timers', title: 'Best for first-timers', text: 'Which of our treks suit first-time trekkers? Recommend upcoming ones first.' },
  { id: 'whatsapp', title: 'Draft WhatsApp reply', text: 'Draft a short WhatsApp reply I can send to this client, recommending our best-fit upcoming trek.' },
  { id: 'seats', title: 'Seats left this month', text: 'Which upcoming treks this month still have seats left?' },
];
