#!/usr/bin/env node
// Turns the result of PART 4 of backup-recent-games.sql into a dated,
// runnable backup file.
//
//   node supabase/ops/write-backup-file.js <downloaded.csv>
//   node supabase/ops/write-backup-file.js --stdin < pasted.txt
//
// Writes backup-YYYY-MM-DD.sql in the current directory (override with --out).
//
// WHY THIS EXISTS
//
// PART 4 runs in the Supabase SQL Editor, which returns rows to a grid - it
// cannot write a file. The SQL Editor's own "Download CSV" wraps every statement
// in CSV quoting and doubles the apostrophes inside it, so the downloaded file
// is NOT runnable SQL: a player named O'Brien comes back as O''Brien inside a
// quoted CSV field and would break the insert. This unwraps that faithfully.
//
// It also checks the result before writing, because a truncated copy-paste
// produces a file that looks fine and restores half a game. See verify() below.
//
// No dependencies and no database credentials: it only reads the file you give
// it. If you do have a direct connection string, you can skip this entirely -
// copy PART 4 into its own file and run it with:
//
//   psql "$DB_URL" -At -f part4.sql > backup-YYYY-MM-DD.sql
//
// (-A unaligned, -t tuples only; without both, psql adds column headers and
// padding that are not valid SQL.)

'use strict';

const fs = require('fs');
const path = require('path');

// ---- CSV ------------------------------------------------------------------
// RFC 4180: fields may be quoted, a quote inside a quoted field is doubled, and
// a quoted field may contain commas and newlines. Written out rather than
// pulled from a package because the whole point of this script is to add no
// dependency to the project for a once-a-day operational task.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }

    if (c === '"') { inQuotes = true; i += 1; continue; }
    if (c === ',') { row.push(field); field = ''; i += 1; continue; }
    if (c === '\r') { i += 1; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }

    field += c; i += 1;
  }

  if (inQuotes) {
    throw new Error(
      'Unterminated quote in the CSV. The download is truncated or was edited.\n' +
      'Re-run PART 4 and download it again rather than patching the file by hand.'
    );
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// ---- verification ---------------------------------------------------------
// A half-copied result is the realistic failure here, and it is silent: the file
// opens, reads like SQL, and restores an incomplete game. These checks make that
// loud instead. They are assertions about the file, not about the database.
function verify(statements) {
  const problems = [];
  const joined = statements.join('\n');

  if (statements.length === 0) problems.push('The input produced no statements at all.');

  const begins = statements.filter((s) => s.trim() === 'begin;').length;
  const commits = statements.filter((s) => s.trim() === 'commit;').length;
  if (begins !== 1) problems.push(`Expected exactly one \`begin;\`, found ${begins}.`);
  if (commits !== 1) problems.push(`Expected exactly one \`commit;\`, found ${commits}.`);

  if (!joined.includes('-- iTala game backup')) {
    problems.push('Missing the `-- iTala game backup` header. This does not look like PART 4 output.');
  }
  if (!joined.includes('-- end of backup')) {
    problems.push('Missing the `-- end of backup` footer. The result was cut short - the grid truncates long outputs, so use Download CSV rather than copying from the cell.');
  }

  // Every generated INSERT ends `do nothing;`. One that does not is a statement
  // that got clipped partway through.
  const clipped = statements.filter(
    (s) => s.trimStart().startsWith('insert into') && !s.trimEnd().endsWith('do nothing;')
  );
  if (clipped.length > 0) {
    problems.push(`${clipped.length} insert statement(s) are truncated (they do not end in \`do nothing;\`). First: ${clipped[0].slice(0, 120)}...`);
  }

  return problems;
}

function countByTable(statements) {
  const counts = new Map();
  for (const s of statements) {
    const m = /^insert into public\.(\w+)/.exec(s.trimStart());
    if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  return counts;
}

// ---- main -----------------------------------------------------------------
function today() {
  // Local date, so the filename matches the day the operator is having. ISO
  // order (YYYY-MM-DD) so a directory of these sorts chronologically; the
  // human-readable date inside the generated file stays as Postgres wrote it.
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function main(argv) {
  const args = argv.slice(2);
  const force = args.includes('--force');
  const useStdin = args.includes('--stdin');
  const outIdx = args.indexOf('--out');
  // Guard the -1 case: without --out, `outIdx + 1` is 0 and would silently
  // discard the first positional argument, i.e. the input file.
  const outValueIdx = outIdx >= 0 ? outIdx + 1 : -1;
  const positional = args.filter((a, i) => !a.startsWith('--') && i !== outValueIdx);

  const outFile = outIdx >= 0 ? args[outIdx + 1] : `backup-${today()}.sql`;

  let raw;
  if (useStdin) {
    raw = fs.readFileSync(0, 'utf8');
  } else if (positional.length === 1) {
    raw = fs.readFileSync(positional[0], 'utf8');
  } else {
    console.error(
      'usage: node supabase/ops/write-backup-file.js <downloaded.csv> [--out FILE] [--force]\n' +
      '       node supabase/ops/write-backup-file.js --stdin [--out FILE] [--force] < pasted.txt'
    );
    return 2;
  }

  const rows = parseCsv(raw);
  if (rows.length === 0) { console.error('Empty input.'); return 1; }

  // Drop the CSV header if present. A plain paste from the grid has no header.
  const first = rows[0][0] === undefined ? '' : rows[0][0].trim();
  const body = (first === 'stmt' || first === '"stmt"') ? rows.slice(1) : rows;

  const statements = body.map((r) => (r[0] === undefined ? '' : r[0]));

  const problems = verify(statements);
  if (problems.length > 0) {
    console.error('REFUSING TO WRITE - the input does not look like a complete PART 4 result:\n');
    for (const p of problems) console.error('  * ' + p);
    console.error('\nNothing was written. Re-run PART 4 and use the SQL Editor\'s Download CSV.');
    return 1;
  }

  const target = path.resolve(outFile);
  if (fs.existsSync(target) && !force) {
    console.error(`REFUSING TO WRITE - ${target} already exists.`);
    console.error('A backup file is not something to clobber by accident. Move it, rename it,');
    console.error('or pass --force if you are certain you want to replace it.');
    return 1;
  }

  fs.writeFileSync(target, statements.join('\n') + '\n', 'utf8');

  const counts = countByTable(statements);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);

  console.log(`Wrote ${target}`);
  console.log(`  ${total} insert statement(s), ${fs.statSync(target).size} bytes`);
  for (const [table, n] of [...counts.entries()].sort()) {
    console.log(`    ${table.padEnd(24)} ${n}`);
  }
  if (total === 0) {
    console.log('\n  NOTE: zero inserts. No games fell in the window - that is a valid result,');
    console.log('  but confirm it against PART 1 before treating this file as a backup.');
  }
  return 0;
}

if (require.main === module) process.exit(main(process.argv));

module.exports = { parseCsv, verify, countByTable };
