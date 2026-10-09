// Extração de JSON atribuído a variável no HTML do YouTube (§8.4). PURO.

/**
 * Encontra `varName = {...}` no HTML e faz JSON.parse do objeto por casamento de chaves
 * (ciente de strings e escapes). Retorna null se não achar ou se o JSON for inválido.
 */
export function extractJsonAssignment(html, varName) {
  if (typeof html !== 'string' || !html) return null;
  const markers = [`var ${varName} = `, `window["${varName}"] = `, `${varName} = `];
  let i = -1;
  for (const m of markers) {
    i = html.indexOf(m);
    if (i !== -1) break;
  }
  if (i === -1) return null;
  const start = html.indexOf('{', i);
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = start; j < html.length; j++) {
    const ch = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, j + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
