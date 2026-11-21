// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// Returns exactly what csv-reader 1.0.0 returns for {text, header}:
// {columns, rows, errors}. Same broken-row policy, same error order:
//   - U+FEFF at the very start is dropped
//   - a record ends at LF or CRLF; a line left with no characters is no record
//   - outside quotes a CR not followed by LF is dropped (stray_cr)
//   - a field opening with a quote runs to the next quote that is not doubled,
//     "" inside is one quote, CRLF / lone CR inside read as LF; what follows
//     the closing quote up to the next comma or line break is appended as it
//     stands (quote_junk, when the field ends); a quote that never closes is
//     a literal character and the text after it is read again as unquoted
//     (unterminated_quote)
//   - a quote inside an unquoted field is a literal character
//   - fields stay strings, never trimmed or converted
//   - columns is the first record when header is true, else null; rows holds
//     the records after it, each padded with "" (short_row, with fields: its
//     count) or cut (long_row, with extra: the cut fields) to the first
//     record's width
//   - each error is {code, line, row}, in the order met; line is the 1-based
//     line its record starts on (every LF, CRLF and lone CR inside quotes
//     counted), row its record's index in rows (null for the header)
//
// Speed: the reference walks one character at a time and builds every field
// with `value += c`. This reader instead jumps with native indexOf scans and
// takes whole fields (and whole runs of unquoted fields) as single slices,
// splitting a quote-free run with the native split. Only genuinely broken
// pieces (quoted fields, stray CRs, quote junk, unterminated quotes) go
// through a per-field reader, and even that jumps between delimiters.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  const hasCR = text.indexOf('\r') !== -1;
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Whether the last field of the record being read was quoted (the empty-record rule needs it).
  let lastQuoted = false;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads an unquoted field starting at pos, with `init` as its value so far
  // ('' for a plain field, '"' for an unterminated re-read, the quoted value
  // for quote junk). Returns {value, ended, added}; `added` counts the
  // characters kept during this read (stray CRs dropped along the way do not
  // count). Jumps between delimiters with indexOf; a stray CR is the only
  // reason it ever loops.
  function readUnquoted(init) {
    let added = 0;
    let parts = null;
    for (;;) {
      const ci = text.indexOf(',', pos);
      const ni = text.indexOf('\n', pos);
      const ri = hasCR ? text.indexOf('\r', pos) : -1;
      let m = -1;
      let which = 0; // 0 none (EOF), 1 comma, 2 LF, 3 CR
      if (ci !== -1) { m = ci; which = 1; }
      if (ni !== -1 && (m === -1 || ni < m)) { m = ni; which = 2; }
      if (ri !== -1 && (m === -1 || ri < m)) { m = ri; which = 3; }
      if (which === 0) {
        if (pos < len) {
          if (parts === null) parts = [];
          parts.push(text.slice(pos, len));
          added += len - pos;
        }
        pos = len;
        return { value: parts === null ? init : init + parts.join(''), ended: END, added };
      }
      if (which === 1) {
        if (m > pos) {
          if (parts === null) parts = [];
          parts.push(text.slice(pos, m));
          added += m - pos;
        }
        pos = m + 1;
        return { value: parts === null ? init : init + parts.join(''), ended: COMMA, added };
      }
      if (which === 2) {
        if (m > pos) {
          if (parts === null) parts = [];
          parts.push(text.slice(pos, m));
          added += m - pos;
        }
        pos = m + 1;
        line += 1;
        return { value: parts === null ? init : init + parts.join(''), ended: LINE_BREAK, added };
      }
      // which === 3: a CR.
      if (text[m + 1] === '\n') {
        if (m > pos) {
          if (parts === null) parts = [];
          parts.push(text.slice(pos, m));
          added += m - pos;
        }
        pos = m + 2;
        line += 1;
        return { value: parts === null ? init : init + parts.join(''), ended: LINE_BREAK, added };
      }
      // A lone CR outside quotes is dropped (stray_cr) and the field goes on.
      error('stray_cr');
      if (m > pos) {
        if (parts === null) parts = [];
        parts.push(text.slice(pos, m));
        added += m - pos;
      }
      pos = m + 1;
    }
  }

  // The text slice [a, b) as a quoted field's piece: plain slice when it holds
  // no line break, else CRLF / lone CR read as LF (and `nl` counts the line
  // breaks in it, which is the line increment the reference applies).
  // `nl` is a one-element holder because this is called from readQuoted.
  function quotedPiece(a, b, nl) {
    const ni = text.indexOf('\n', a);
    const hasNl = ni !== -1 && ni < b;
    const ri = text.indexOf('\r', a);
    const hasCr = ri !== -1 && ri < b;
    if (!hasNl && !hasCr) return text.slice(a, b);
    if (hasNl && !hasCr) {
      let n = 0;
      let k = a - 1;
      while ((k = text.indexOf('\n', k + 1)) !== -1 && k < b) n++;
      nl[0] += n;
      return text.slice(a, b);
    }
    const norm = text.slice(a, b).replace(/\r\n?/g, '\n');
    let n = 0;
    let k = -1;
    while ((k = norm.indexOf('\n', k + 1)) !== -1) n++;
    nl[0] += n;
    return norm;
  }

  // Reads a quoted field whose opening quote is at pos. Returns {value, ended}.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    const nl = [0];
    let parts = null;
    let segStart = pos + 1;
    let i = pos + 1;
    let value;
    for (;;) {
      const q = text.indexOf('"', i);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted. `line` is still openLine: the
        // scan above counted nothing into it (nl is local and discarded).
        error('unterminated_quote');
        pos = open + 1;
        return readUnquoted('"');
      }
      if (text[q + 1] === '"') {
        // A doubled quote inside: one quote, and the field goes on.
        if (parts === null) parts = [];
        parts.push(quotedPiece(segStart, q, nl));
        parts.push('"');
        i = q + 2;
        segStart = q + 2;
        continue;
      }
      // The closing quote.
      if (parts === null) value = quotedPiece(segStart, q, nl);
      else {
        parts.push(quotedPiece(segStart, q, nl));
        value = parts.join('');
      }
      line += nl[0];
      pos = q + 1;
      break;
    }
    if (pos >= len) return { value, ended: END };
    const c = text[pos];
    if (c === ',') {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === '\n') {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === '\r' && text[pos + 1] === '\n') {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) error('quote_junk');
    return junk;
  }

  // Reads one record starting at pos (blank lines already skipped, pos < len).
  // Returns the record's fields; `lastQuoted` says whether its last field was
  // quoted. Advances pos past the record's line break (or to the end).
  function readRecord() {
    const fields = [];
    let fieldMode = false; // set once a stray CR forces per-field reading
    for (;;) {
      if (text[pos] === '"') {
        const f = readQuoted();
        fields.push(f.value);
        lastQuoted = true;
        if (f.ended !== COMMA) return fields;
        continue;
      }
      if (fieldMode) {
        const f = readUnquoted('');
        fields.push(f.value);
        lastQuoted = false;
        if (f.ended !== COMMA) return fields;
        continue;
      }
      // A run of unquoted fields: up to the next quoted field (',"'), the
      // next line break, or the end of the text. A quote inside an unquoted
      // field is literal, so only ',"' can open a quoted field here.
      let q2 = -1;
      {
        let qi = text.indexOf('"', pos);
        while (qi !== -1) {
          if (text[qi - 1] === ',') { q2 = qi - 1; break; }
          qi = text.indexOf('"', qi + 1);
        }
      }
      const ni = text.indexOf('\n', pos);
      let runEnd;
      let runKind; // 0 quoted field follows, 1 line break, 2 end of text
      if (ni !== -1 && (q2 === -1 || ni < q2)) { runEnd = ni; runKind = 1; }
      else if (q2 !== -1) { runEnd = q2; runKind = 0; }
      else { runEnd = len; runKind = 2; }
      const ri = hasCR ? text.indexOf('\r', pos) : -1;
      if (ri !== -1 && ri < runEnd) {
        if (runKind === 1 && ri === runEnd - 1) {
          // CRLF: the run ends at the CR.
          const chunk = text.slice(pos, ri);
          const ps = chunk.split(',');
          for (let k = 0; k < ps.length; k++) fields.push(ps[k]);
          lastQuoted = false;
          pos = runEnd + 1;
          line += 1;
          return fields;
        }
        // A stray CR inside the run: read this record's fields one by one.
        fieldMode = true;
        continue;
      }
      if (runKind === 1) {
        const chunk = text.slice(pos, runEnd);
        const ps = chunk.split(',');
        for (let k = 0; k < ps.length; k++) fields.push(ps[k]);
        lastQuoted = false;
        pos = runEnd + 1;
        line += 1;
        return fields;
      }
      if (runKind === 0) {
        const chunk = text.slice(pos, runEnd);
        const ps = chunk.split(',');
        for (let k = 0; k < ps.length; k++) fields.push(ps[k]);
        lastQuoted = false;
        pos = runEnd + 1; // at the opening quote of the next field
        continue;
      }
      // runKind === 2: the run ends at the end of the text.
      const chunk = text.slice(pos, runEnd);
      const ps = chunk.split(',');
      for (let k = 0; k < ps.length; k++) fields.push(ps[k]);
      lastQuoted = false;
      pos = len;
      return fields;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      if (text[pos] === '\n') {
        pos += 1;
        line += 1;
      } else if (text[pos] === '\r' && text[pos + 1] === '\n') {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = readRecord();

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
