/**
 * Lightweight CSV parser/stringifier to avoid extra dependencies.
 * Supports:
 * - Header row
 * - Quoted fields with escaped quotes ("")
 * - Comma delimiter
 */

class Parser {
  parse(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (!lines.length) return { headers: [], rows: [] };

    const headers = this._splitLine(lines[0]);
    const rows = lines.slice(1).map((line) => this._splitLine(line));
    return { headers, rows };
  }

  stringify(rows) {
    return rows.map((row) => row.map((cell) => this._escape(cell)).join(',')).join('\n');
  }

  _splitLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current);
    return result;
  }

  _escape(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (/[",\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }
}

export { Parser };
