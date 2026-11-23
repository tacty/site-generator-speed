// A faster drop-in for makefun-site 1.0.0: run(input) returns exactly the output tree makefun-site's build
// returns, byte for byte, built with bulk string work instead of per-character rendering, a compiled template
// renderer instead of a tree walk, and memoised slugs. The dialect rules are makefun-site's own (its README and
// code are the reference); every error string and edge case below mirrors them.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

const SLUG_MAX = 64;

function slugifyRaw(text) {
  // NFKD is the identity on pure ASCII and ASCII holds no combining marks, so only non-ASCII pays for it.
  const plain = /[^\x00-\x7F]/.test(text) ? text.normalize('NFKD').replace(/\p{M}/gu, '') : text;
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

const slugCache = new Map();
function slugify(text) {
  let slug = slugCache.get(text);
  if (slug === undefined) {
    slug = slugifyRaw(text);
    slugCache.set(text, slug);
  }
  return slug;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** The non-ASCII whitespace code points of JavaScript's \s at 256 and above (the rest are a table). */
const WS_UNICODE = new Set([0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]);
for (let cp = 0x2000; cp <= 0x200a; cp++) WS_UNICODE.add(cp);

/** JavaScript's \s as a table for code units under 256. */
const WS_TABLE = new Uint8Array(256);
for (const cp of [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0]) WS_TABLE[cp] = 1;

/** Whether a code unit is JavaScript whitespace (\s). */
function isWsCode(code) {
  return code < 256 ? WS_TABLE[code] === 1 : WS_UNICODE.has(code);
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 256 ? WS_TABLE[code] === 1 : WS_UNICODE.has(code)) inWord = false;
    else if (!inWord) {
      count++;
      inWord = true;
    }
  }
  return count;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

function fmStringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function fmValueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmStringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // Find the closing --- first (an unclosed front matter reports that, whatever its lines hold), collecting
  // only the front matter's own lines; the body is the rest of the text, unsplit.
  const fmLines = [];
  let bodyStart = -1;
  let idx = 4;
  while (text !== '---') {
    const nl = text.indexOf('\n', idx);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(idx, lineEnd);
    if (line === '---') {
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    if (nl === -1) break;
    fmLines.push(line);
    idx = nl + 1;
  }
  if (bodyStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown: line shapes

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

function isLangChar(c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-';
}

/** A fence-opening line's language, or null (the reference's /^```([A-Za-z0-9_+-]*)[ \t]*$/). */
function fenceOpenOf(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length && isLangChar(line[i])) i++;
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return null;
    i++;
  }
  return lang;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n === 0 || n > 6 || n >= line.length) return null;
  const c = line[n];
  if (c !== ' ' && c !== '\t') return null;
  let a = n;
  while (a < line.length && (line[a] === ' ' || line[a] === '\t')) a++;
  let b = line.length;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  if (b <= a) return null;
  return { depth: n, text: line.slice(a, b) };
}

function isHR(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** A bullet item's text after "- " or "* ", or null. */
function bulletOf(line) {
  const c = line[0];
  return (c === '-' || c === '*') && line[1] === ' ' ? line.slice(2) : null;
}

/** An ordered item's number and text after "N. ", or null. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && line[i] >= '0' && line[i] <= '9') i++;
  if (i === 0 || i > 9) return null;
  if (line[i] !== '.' || line[i + 1] !== ' ') return null;
  return { num: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

function isContinued(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  return i >= 2 && i < line.length && !isWsCode(line.charCodeAt(i));
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function endsParagraph(line) {
  return isBlank(line) || fenceOpenOf(line) !== null || headingOf(line) !== null || isHR(line);
}

// ---------------------------------------------------------------- markdown: inline

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index in [from, end) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wlen = what.length;
  for (let j = from; j <= end - wlen; j++) {
    if (s[j] === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * in [from, end) (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (j + 1 < end && s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s[start, end)` rendered inline; `env.link(target)` is a link's href. Plain runs are escaped in bulk; the
 * constructs recurse on index ranges of the same string, exactly where the reference recursed on slices.
 */
function inlineRange(s, start, end, env) {
  let out = '';
  let run = start;
  let i = start;
  while (i < end) {
    const c = s[i];
    if (c === '\\' && i + 1 < end && ESCAPABLE.has(s[i + 1])) {
      if (i > run) out += escapeHtml(s.slice(run, i));
      out += escapeHtml(s[i + 1]);
      i += 2;
      run = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < end && j > i + 1) {
        if (i > run) out += escapeHtml(s.slice(run, i));
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
        run = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (i + 1 < end && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, end);
        if (j > i + 2) {
          if (i > run) out += escapeHtml(s.slice(run, i));
          out += `<strong>${inlineRange(s, i + 2, j, env)}</strong>`;
          i = j + 2;
          run = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1, end);
      if (j > i + 1) {
        if (i > run) out += escapeHtml(s.slice(run, i));
        out += `<em>${inlineRange(s, i + 1, j, env)}</em>`;
        i = j + 1;
        run = i;
      } else i++;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1, end);
      let done = false;
      if (k !== -1 && k + 1 < end && s[k + 1] === '(') {
        const m = s.indexOf(')', k + 2);
        if (m !== -1 && m < end) {
          const target = s.slice(k + 2, m);
          if (target !== '' && !/\s/.test(target)) {
            if (i > run) out += escapeHtml(s.slice(run, i));
            out += `<a href="${escapeHtml(env.link(target))}">${inlineRange(s, i + 1, k, env)}</a>`;
            i = m + 1;
            run = i;
            done = true;
          }
        }
      }
      if (!done) i++;
      continue;
    }
    i++;
  }
  if (end > run) out += escapeHtml(s.slice(run, end));
  return out;
}

// ---------------------------------------------------------------- markdown: blocks

function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = '';
  let excerptSet = false;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceOpenOf(line);
    if (lang !== null) {
      i++;
      let body = '';
      while (i < n && !isFenceClose(lines[i])) {
        body += `${escapeHtml(lines[i])}\n`;
        i++;
      }
      i++;
      parts.push(`<pre><code${lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`}>${body}</code></pre>\n`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inlineRange(heading.text, 0, heading.text.length, env);
      parts.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) {
      parts.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const raw = lines[i];
        i++;
        const stripped = raw.startsWith('> ') ? raw.slice(2) : raw.slice(1);
        const t = trimLine(stripped);
        if (t !== '') body.push(t);
      }
      if (body.length === 0) parts.push('<blockquote>\n</blockquote>\n');
      else {
        const joined = body.join('\n');
        parts.push(`<blockquote>\n<p>${inlineRange(joined, 0, joined.length, env)}</p>\n</blockquote>\n`);
      }
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [[trimLine(isOrdered ? ordered.text : bullet)]];
      i++;
      while (i < n) {
        const l2 = lines[i];
        if (isOrdered) {
          const m = orderedOf(l2);
          if (m !== null) {
            items.push([trimLine(m.text)]);
            i++;
            continue;
          }
        } else {
          const m = bulletOf(l2);
          if (m !== null) {
            items.push([trimLine(m)]);
            i++;
            continue;
          }
        }
        if (isContinued(l2)) {
          items[items.length - 1].push(trimLine(l2));
          i++;
          continue;
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      let html = `${isOrdered && ordered.num !== 1 ? `<ol start="${ordered.num}">` : `<${tag}>`}\n`;
      for (const partsOfItem of items) {
        const item = partsOfItem.join('\n');
        html += `<li>${inlineRange(item, 0, item.length, env)}</li>\n`;
      }
      parts.push(`${html}</${tag}>\n`);
      continue;
    }
    const plines = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      plines.push(trimLine(lines[i]));
      i++;
    }
    const text = plines.join('\n');
    const html = inlineRange(text, 0, text.length, env);
    if (!excerptSet) {
      excerpt = html;
      excerptSet = true;
    }
    parts.push(`<p>${html}</p>\n`);
  }
  return { html: parts.join(''), toc, excerpt };
}

// ---------------------------------------------------------------- templates: parse (the reference's own algorithm)

class TemplateError extends Error {}

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

function tplPathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tplTokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: tplPathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tplTokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: tplPathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: tplPathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// ---------------------------------------------------------------- templates: compile and render

/** The value at `path`: its first name from the innermost frame holding it, then own properties. */
function tplLookup(frames, path) {
  const key = path[0];
  for (let fi = frames.length - 1; fi >= 0; fi--) {
    const vars = frames[fi];
    if (Object.hasOwn(vars, key)) {
      let v = vars[key];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

function tplTextOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(tplTextOf).join(', ');
  return '';
}

function tplTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function compileNodes(nodes, code) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        code.push(`o+=${JSON.stringify(n.text)};`);
        break;
      case 'var':
        code.push(`o+=H.e(H.t(H.l(S,${JSON.stringify(n.path)})));`);
        break;
      case 'raw':
        code.push(`o+=H.t(H.l(S,${JSON.stringify(n.path)}));`);
        break;
      case 'if':
        code.push(`if(H.f(H.l(S,${JSON.stringify(n.path)}))!==${n.not}){`);
        compileNodes(n.then, code);
        if (n.else !== null) {
          code.push('}else{');
          compileNodes(n.else, code);
        }
        code.push('}');
        break;
      case 'for':
        code.push(`{const xs=H.l(S,${JSON.stringify(n.path)});if(Array.isArray(xs)){const ln=xs.length;for(let k=0;k<ln;k++){const fr={[${JSON.stringify(n.name)}]:xs[k]};fr.loop={index:k+1,first:k===0,last:k===ln-1,length:ln};S.push(fr);`);
        compileNodes(n.body, code);
        code.push('S.pop();}}}');
        break;
      case 'include':
        code.push(`o+=H.i(${JSON.stringify(n.name)},S,D);`);
        break;
    }
  }
}

function compileTemplate(nodes) {
  const code = ['let o="";'];
  compileNodes(nodes, code);
  code.push('return o;');
  return new Function('S', 'D', 'H', code.join('\n'));
}

// ---------------------------------------------------------------- the build

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** One site's output tree: path -> text, exactly makefun-site 1.0.0's. */
export function run(input) {
  const report = [];
  const asts = new Map();
  const compiled = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      const nodes = parseTemplate(name, input.templates[name]);
      asts.set(name, nodes);
      compiled.set(name, compileTemplate(nodes));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const H = {
    e: escapeHtml,
    t: tplTextOf,
    f: tplTruthy,
    l: tplLookup,
    i: (name, S, D) => {
      const fn = compiled.get(name);
      return fn !== undefined && D < 8 ? fn(S, D + 1, H) : '';
    },
  };
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter: a refused source is reported and dropped, and so is a draft; the checks run in this order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!asts.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: each page's slug made unique in its directory, in source order.
  const bySource = new Map();
  {
    const taken = new Map();
    const takenIn = (dir) => {
      if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
      return taken.get(dir);
    };
    for (const s of kept) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${base}/${s.outDir}/`;
      bySource.set(s.path, s);
    }
  }

  // 4. Markdown, its links resolved to the pages and static files they name.
  const broken = new Set();
  {
    const staticPaths = new Set(statics.map((f) => f.path));
    for (const s of kept) {
      const dir = dirOf(s.path);
      const env = {
        link: (target) => {
          if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
          if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
          broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        },
      };
      const md = renderMarkdown(s.body, env);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
    }
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by slug, named as first met in the posts' order, ordered by count then slug.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts: every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  const dateLongOf = (s) => s._dl ?? (s._dl = s.data.date === undefined ? '' : longDate(s.data.date));
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: dateLongOf(s) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: dateLongOf(s),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s._rm ?? (s._rm = Math.max(1, Math.ceil(wordsOf(s.body) / 200))),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const fn = compiled.get(name);
    return fn === undefined ? null : fn([{ site, tags: allTags, recent, ...vars }], 0, H);
  };
  for (const s of kept) {
    const page = {
      ...cardOf(s),
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pageCount, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pageCount ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every reported line and broken link, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageTotal = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageTotal} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
