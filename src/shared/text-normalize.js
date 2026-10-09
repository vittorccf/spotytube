// Normalização de texto (§8.2). PURO: sem chrome.*, sem fetch.

const STOPWORDS = new Set(['the', 'a', 'an', 'o', 'os', 'as', 'de', 'da', 'do', 'el', 'la', 'los', 'las', 'le', 'les']);

/** Minúsculas, sem acentos, & -> and, sem apóstrofos, só letras/números separados por 1 espaço. */
export function normalize(s) {
  if (s == null) return '';
  return String(s)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`´]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Tokens normalizados sem stopwords; se ficar vazio, retorna sem filtrar. */
export function tokens(s) {
  const all = normalize(s).split(' ').filter(Boolean);
  const filtered = all.filter((t) => !STOPWORDS.has(t));
  return filtered.length ? filtered : all;
}

/** Coeficiente de Dice sobre conjuntos de tokens: 2|A∩B|/(|A|+|B|). */
export function dice(aTokens, bTokens) {
  const A = new Set(aTokens || []);
  const B = new Set(bTokens || []);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/** |needle ∩ hay| / |needle| (conjuntos). 0 se needle vazio. */
export function coverage(needle, hay) {
  const N = new Set(needle || []);
  const H = new Set(hay || []);
  if (!N.size) return 0;
  let inter = 0;
  for (const t of N) if (H.has(t)) inter++;
  return inter / N.size;
}

/** Frase normalizada contida como palavras inteiras no texto normalizado. */
export function containsPhrase(normHay, normPhrase) {
  if (!normPhrase) return false;
  return (' ' + (normHay || '') + ' ').includes(' ' + normPhrase + ' ');
}

/**
 * "1:02:03" | "3:45" -> segundos. Também aceita rótulo de acessibilidade em inglês
 * ("3 minutes, 45 seconds", "1 hour, 2 minutes"). null se não reconhecer.
 */
export function parseDuration(text) {
  if (text == null) return null;
  const t = String(text).trim();
  if (/^\d+(:\d{1,2}){1,2}$/.test(t)) {
    return t.split(':').map(Number).reduce((acc, n) => acc * 60 + n, 0);
  }
  const re = /(\d+)\s*(hour|hours|minute|minutes|second|seconds)\b/gi;
  let m; let total = 0; let found = false;
  while ((m = re.exec(t))) {
    found = true;
    const n = Number(m[1]);
    const u = m[2].toLowerCase();
    total += u.startsWith('hour') ? n * 3600 : u.startsWith('minute') ? n * 60 : n;
  }
  return found ? total : null;
}

/** "1,234,567 views" | "1.2M views" | "No views" -> número | null (hl=en). */
export function parseViews(text) {
  if (text == null) return null;
  const t = String(text).trim();
  if (/^no views/i.test(t)) return 0;
  const short = t.match(/([\d.]+)\s*([KMB])\b/i);
  if (short) {
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[short[2].toLowerCase()];
    const n = parseFloat(short[1]);
    return Number.isFinite(n) ? Math.round(n * mult) : null;
  }
  const m = t.match(/[\d][\d,.\s]*/);
  if (!m) return null;
  const n = Number(m[0].replace(/[^\d]/g, ''));
  return Number.isFinite(n) ? n : null;
}

const FLAG_PATTERNS = {
  remix: ['remix', 'mix'],
  live: ['live', 'ao vivo', 'en vivo'],
  acoustic: ['acoustic', 'acustico'],
  instrumental: ['instrumental'],
  remaster: ['remaster', 'remastered'],
  edit: ['radio edit', 'edit'],
};

/**
 * Flags (palavras inteiras) presentes em `text`. Palavras que fazem parte de `coreText`
 * (o nome "limpo" da música) não contam — "Live Forever" não é live, "Cover Me" não é cover.
 */
export function detectFlags(text, coreText = '') {
  const n = normalize(text);
  // núcleo = nome sem grupos (...)/[...] e sem sufixo ' - ...'
  const core = normalize(String(coreText || '').replace(/\s*[\(\[【][^\)\]】]*[\)\]】]/g, ' ').split(/\s[-–—]\s/)[0]);
  const flags = {};
  for (const [flag, phrases] of Object.entries(FLAG_PATTERNS)) {
    flags[flag] = phrases.some((p) => containsPhrase(n, p) && !containsPhrase(core, p));
  }
  return flags;
}

const SUFFIX_RE = /(remaster|remastered|version|versão|edit|mono|stereo|mix|remix|live|ao vivo|acoustic|deluxe|bonus|from |feat|with |single|anniversary|\d{4})/i;
const GROUP_WORD_RE = /(?<![\p{L}\p{N}])(feat\.?|ft\.|with|com|remaster(?:ed)?|version|versão|edit|from|mix|remix|live|ao vivo)(?![\p{L}\p{N}])/iu;

/** Remove grupos (...) / [...] cujo conteúdo case `re`. */
function stripGroups(s, re) {
  return s.replace(/\s*[\(\[]([^\)\]]*)[\)\]]/g, (whole, inner) => (re.test(inner) ? '' : whole));
}

/**
 * Limpa nome de faixa do Spotify.
 * @returns {{clean:string, flags:{remix:boolean,live:boolean,acoustic:boolean,instrumental:boolean,remaster:boolean,edit:boolean}}}
 */
export function cleanSpotifyTitle(name) {
  const original = String(name ?? '');
  let s = original;
  // 2. sufixo após " - "
  let idx = s.indexOf(' - ');
  while (idx !== -1) {
    const suffix = s.slice(idx + 3);
    if (SUFFIX_RE.test(suffix)) { s = s.slice(0, idx); break; }
    idx = s.indexOf(' - ', idx + 3);
  }
  // 3. grupos (feat. X), [with Y], (Remastered) ...
  s = stripGroups(s, GROUP_WORD_RE);
  // 4.
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) s = original.trim();
  // 1. flags — calculadas no nome original, ignorando palavras do núcleo limpo
  const flags = detectFlags(original, s);
  return { clean: s, flags };
}
