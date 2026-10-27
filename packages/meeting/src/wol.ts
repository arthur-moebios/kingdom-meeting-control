/**
 * Minimal wol.jw.org reader. Fetches the public meetings page + the midweek
 * "Vida e Ministério" document and extracts the timed parts. No dependency: the
 * HTML is converted to lines and parsed by the stable on-screen structure
 * (section headers + numbered parts + "(N min)" markers).
 *
 * We only read publicly available scheduling data (part titles + allotted
 * minutes). No login, no personal data.
 */

const ORIGIN = "https://wol.jw.org";

/** The uppercase section headers of the midweek meeting (accent-insensitive). */
const MIDWEEK_SECTIONS = [
  "TESOUROS DA PALAVRA DE DEUS",
  "FACA SEU MELHOR NO MINISTERIO",
  "NOSSA VIDA CRISTA",
];

export interface RawPart {
  section: string;
  title: string;
  minutes: number;
}

export interface MidweekResult {
  weekLabel: string;
  title: string;
  parts: RawPart[];
}

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)));
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Isolate the <article> body, turn block boundaries into newlines, strip tags. */
function htmlToLines(html: string): string[] {
  const art = /<article[\s\S]*?<\/article>/i.exec(html);
  const body = art ? art[0] : html;
  const withBreaks = body
    .replace(/<\/(h1|h2|h3|h4|h5|p|li|div|td|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  return withBreaks
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((l) => decodeEntities(l).replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0);
}

/** All anchors pointing at a /wol/d/ document, in order. */
function docLinks(html: string): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = [];
  const re = /<a\b[^>]*href="([^"]*\/wol\/d\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const text = stripTags(m[2] ?? "");
    if (href && text) out.push({ href, text });
  }
  return out;
}

/** Extract just the date range (e.g. "26 de outubro–1.º de novembro"). */
function cleanWeekLabel(text: string): string {
  const m = text.match(
    /\d{1,2}(?:\.º)?\s+de\s+[a-zç]+\s*[–-]\s*\d{1,2}(?:\.º)?\s+de\s+[a-zç]+/i,
  );
  return (m ? m[0] : text).replace(/\s+/g, " ").trim();
}

/** Drop a trailing publication reference the anchor card appended. */
function cleanTitle(text: string): string {
  return text
    .replace(/\s+(A Sentinela|Apostila|Cântico|Cântico)\b.*$/i, "")
    .replace(/\s*\|.*$/, "")
    .replace(/\s+—\s+\d{4}.*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function abs(href: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  return ORIGIN + (href.startsWith("/") ? href : "/" + href);
}

async function fetchText(url: string, timeoutMs = 15000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "KingdomMeetingControl/0.1 (+local)",
        "Accept-Language": "pt-BR,pt;q=0.9",
        Accept: "text/html",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

/** Parse the midweek document lines into timed parts. */
export function parseMidweekParts(lines: string[]): RawPart[] {
  const parts: RawPart[] = [];
  let section = "Início";
  let pending: RawPart | null = null;

  const flushPending = (): void => {
    if (pending) {
      parts.push(pending);
      pending = null;
    }
  };

  const minOf = (line: string): number | null => {
    const m = line.match(/\((\d+)\s*min\)/i);
    return m && m[1] ? parseInt(m[1], 10) : null;
  };

  for (const line of lines) {
    const bare = stripAccents(line).toUpperCase();
    const sec = MIDWEEK_SECTIONS.find((s) => bare.startsWith(s));
    if (sec) {
      flushPending();
      // Keep the accented, human form from the line itself.
      section = line.replace(/\s*\(.*$/, "").trim();
      continue;
    }

    if (/coment[aá]rios iniciais/i.test(line)) {
      flushPending();
      parts.push({ section: "Início", title: "Comentários iniciais", minutes: minOf(line) ?? 1 });
      continue;
    }
    if (/coment[aá]rios finais/i.test(line)) {
      flushPending();
      parts.push({ section: "Conclusão", title: "Comentários finais", minutes: minOf(line) ?? 3 });
      continue;
    }

    const numbered = line.match(/^(\d+)\.\s+(.*)$/);
    if (numbered) {
      flushPending();
      let title = numbered[2] ?? "";
      const inline = minOf(title);
      title = title.replace(/\s*\(\d+\s*min\).*$/i, "").trim();
      if (inline !== null) {
        parts.push({ section, title, minutes: inline });
      } else {
        pending = { section, title, minutes: 0 };
      }
      continue;
    }

    // A "(N min) ..." line that belongs to the pending numbered part.
    if (pending && /^\(\d+\s*min\)/i.test(line)) {
      pending.minutes = minOf(line) ?? 0;
      flushPending();
    }
  }
  flushPending();
  // Drop anything that ended up with no time (defensive).
  return parts.filter((p) => p.minutes > 0);
}

export class WolClient {
  /** Fetch + parse the midweek meeting for a given meetings-page URL. */
  async fetchMidweek(meetingsUrl: string): Promise<MidweekResult> {
    const overview = await fetchText(meetingsUrl);
    const links = docLinks(overview);
    const midweek = links.find((l) => /^\d/.test(l.text)) ?? links[0];
    if (!midweek) throw new Error("Nenhum documento de reunião encontrado no WOL.");
    const weekLabel = cleanWeekLabel(midweek.text);

    const doc = await fetchText(abs(midweek.href));
    const parts = parseMidweekParts(htmlToLines(doc));
    if (parts.length === 0) throw new Error("Não consegui extrair as partes do meio de semana.");
    return { weekLabel, title: "Nossa Vida e Ministério Cristão", parts };
  }

  /** The weekend meeting: public talk + Watchtower study title (from overview). */
  async fetchWeekend(meetingsUrl: string): Promise<{ weekLabel: string; watchtowerTitle: string }> {
    const overview = await fetchText(meetingsUrl);
    const links = docLinks(overview);
    const midweek = links.find((l) => /^\d/.test(l.text));
    const weekendLink = links.find((l) => l !== midweek && !/^\d/.test(l.text));
    const weekLabel = cleanWeekLabel(midweek?.text ?? "");
    const watchtowerTitle = cleanTitle(weekendLink?.text ?? "");
    return { weekLabel, watchtowerTitle };
  }
}
