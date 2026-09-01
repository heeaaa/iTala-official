// ============================================================================
// Bulk roster parser. Deterministic, conservative: it never guesses
// destructively — anything suspicious is FLAGGED for the review screen, and
// unparseable content is kept verbatim as a name so the user can fix it.
//
// Supported player formats (all seen in real pastes):
//   "Juan Dela Cruz-17"                name-dash-number
//   "Juan Dela Cruz 22"                name-space-number
//   "1:Juan Dela Cruz #24"             index-colon-name-hash-number
//   "Juan Dela Cruz#14"                hash with no space
//   "Juan Dela Cruz # 2"               hash with space
//   "#11 Juan Dela Cruz"               hash-number FIRST, then the name
//   "# 3 Juan Dela Cruz"               same, with a space after the hash
//   "Juan Dela Cruz (Juan) #16"        nickname (dropped)
//   "11. Juan Dela Cruz#3 - Juan"      trailing nickname after number (dropped)
// Rules: leading index (1. / 2: / 3) / "10 ") stripped when a real number
// exists elsewhere; jersey numbers kept as written incl. leading zeros;
// missing number is fine (NOT flagged); unusual numbers are fine (NOT
// flagged); slash in name is flagged; a line with no player-line signal, sitting
// between players, is flagged as a possible stray.
//
// Team headers are recognised by the ABSENCE of a player-line signal, not by the
// absence of digits. Digits in a team name are ordinary - "Eagles 2024",
// "U14 Warriors", "Hawks 2025" - and the old `/\d/` test made every one of them
// unrecognisable as a header, so the team fell back to a "Team N" placeholder and
// its real name was consumed as a player. See F-12 and GROUP O in
// tests/reducer.test.js.
//
// Known limitation, kept deliberately: a short "Name N" header such as "Team 2"
// is structurally identical to a player line like "Pedro Santos 9", so it is
// still read as a player. Resolving it would need to guess, and guessing wrong
// silently corrupts an import - which is the one thing this parser will not do.
// ============================================================================

export interface ParsedPlayer {
  name: string;
  number: string;        // as written, '' when absent
  flag?: string;         // one-line reason shown on the review screen
  raw: string;           // original line, for reference
}
export interface ParsedTeam { name: string; players: ParsedPlayer[] }

// The three jersey-number shapes, plus the leading-index shape. Named because
// header detection and number extraction must agree: if a line looks like a
// player line to one and not the other, a team name gets eaten as a player.
const JERSEY_HASH = /#\s*(\d+)/;              // "#24", "# 2", "Juan#14"
const JERSEY_DASH = /[-–]\s*(\d+)\s*$/;       // "Juan-17", "Juan- 19"
// Capped at 3 digits deliberately. A bare trailing run of 4 or more is a year,
// not a jersey number - "Eagles 2024" is a team, "Ana Lim 100" is a player. The
// real sample contains a 420, so 3 has to keep working. See F-12 / GROUP O.
const JERSEY_TAIL = /\s(\d{1,3})\s*$/;        // "Juan 22"
const LEADING_INDEX = /^\s*\d{1,3}\s*[.:)\]]\s*/; // "1.", "2:", "3)"

// Does this line carry a player-line signal? This is what decides header vs
// player, replacing an earlier `/\d/.test(line)` that treated any digit anywhere
// as proof of a player line - and so made every team name containing a digit
// unrecognisable as a header (F-12).
function looksLikePlayerLine(s: string): boolean {
  return JERSEY_HASH.test(s) || JERSEY_DASH.test(s)
      || JERSEY_TAIL.test(s) || LEADING_INDEX.test(s);
}

// Parse one player line into { name, number }.
function parsePlayerLine(line: string): { name: string; number: string } {
  let s = line.trim();

  // 1) Extract the jersey number.
  let number = '';
  let nameSpan = s;

  const hash = s.match(JERSEY_HASH);
  if (hash && hash.index !== undefined) {
    number = hash[1];
    const before = s.slice(0, hash.index);      // drop everything from # on
    // "#11 Juan Dela Cruz" - the number LEADS the line, so the name is what
    // FOLLOWS it. Taking the text before the hash is right for every other
    // supported shape ("Juan #24", "Juan#14", and "Juan#3 - Jun" where slicing
    // is what drops the trailing nickname) and produces nothing at all here:
    // the name then fell back to the raw line, so the row imported as
    // number 11 / name "#11 Juan Dela Cruz", with the number left in the name.
    nameSpan = before.trim() ? before : s.slice(hash.index + hash[0].length);
  } else {
    const dash = s.match(JERSEY_DASH);
    if (dash && dash.index !== undefined) {
      number = dash[1];
      nameSpan = s.slice(0, dash.index);
    } else {
      const tail = s.match(JERSEY_TAIL);
      if (tail && tail.index !== undefined) {
        number = tail[1];
        nameSpan = s.slice(0, tail.index);
      }
    }
  }

  // 2) Strip a leading index from the name span — "1.", "2:", "3)", "10 ".
  //    Only when it looks like an index (short digits + separator), so a
  //    number-less line that's just a name is untouched.
  nameSpan = nameSpan.replace(LEADING_INDEX, '');
  // bare "10 Juan ..." (digits + space, no separator) — only strip when a
  // real jersey number was found elsewhere, otherwise it could BE the number.
  if (number) nameSpan = nameSpan.replace(/^\s*\d{1,3}\s+/, '');

  // 3) Drop nicknames/parenthesised segments and dangling separators.
  nameSpan = nameSpan.replace(/\(.*?\)/g, ' ');
  nameSpan = nameSpan.replace(/[-–#]\s*$/, ' ');
  const name = nameSpan.replace(/\s+/g, ' ').trim();

  return { name, number };
}

export function parseRoster(text: string): ParsedTeam[] {
  const rawLines = text.split(/\r?\n/);
  const teams: ParsedTeam[] = [];
  let current: ParsedTeam | null = null;
  let prevBlank = true; // start-of-text behaves like after a blank line

  for (const raw of rawLines) {
    const line = raw.trim();
    if (!line) { prevBlank = true; continue; }

    if (!looksLikePlayerLine(line)) {
      if (prevBlank || !current || current.players.length === 0) {
        // Preceded by a blank line (or nothing yet) → a team header.
        current = { name: line.replace(/\s+/g, ' '), players: [] };
        teams.push(current);
      } else {
        // Sandwiched between player lines → possible stray. Two different things
        // land here and the parser cannot tell them apart: a genuine stray (the
        // "Jun" case in the real sample) and a second team header pasted with no
        // blank line before it. Guessing would silently either lose a player or
        // split a team, so it is flagged and the review screen offers
        // promoteStrayToTeam() for the header case.
        current.players.push({
          name: line, number: '', raw: line,
          flag: 'Possible stray line — a player, or a team header?',
        });
      }
      prevBlank = false;
      continue;
    }

    // Player line. If no team has started yet, create an implicit one so
    // nothing is lost; the user can rename it on the review screen.
    if (!current) {
      current = { name: `Team ${teams.length + 1}`, players: [] };
      teams.push(current);
    }
    const { name, number } = parsePlayerLine(line);
    const player: ParsedPlayer = { name: name || line, number, raw: line };
    if (player.name.includes('/')) {
      player.flag = 'Slash in name — one player or two?';
    }
    current.players.push(player);
    prevBlank = false;
  }

  // Drop teams that ended up completely empty (e.g. trailing header).
  return teams.filter(t => t.players.length > 0 || t.name);
}

// Turn a flagged row that is really a team header into its own team, taking the
// rows below it along.
//
// Needed because two teams pasted back to back with no blank line between them
// look like one team with a stray row in the middle - the parser flags it rather
// than guess (see parseRoster). This is the review screen's resolution for the
// header case, and it is a pure function so it can be tested without rendering
// the screen.
//
// "Reds / Ana / Blues* / Ben"  ->  "Reds / Ana"  +  "Blues / Ben"
//
// Returns the input unchanged if the indices do not point at a real row, so a
// stale index from a re-render cannot corrupt the list.
export function promoteStrayToTeam(teams: ParsedTeam[], ti: number, pi: number): ParsedTeam[] {
  const team = teams[ti];
  if (!team) return teams;
  const header = team.players[pi];
  if (!header) return teams;

  const kept = { ...team, players: team.players.slice(0, pi) };
  const promoted: ParsedTeam = {
    // A blank header name would make the team unimportable (commit() drops
    // nameless teams), so fall back the same way an added team row does.
    name: header.name.trim() || `Team ${teams.length + 1}`,
    // Everything after the header belonged to it, not to the team above.
    players: team.players.slice(pi + 1),
  };
  return [...teams.slice(0, ti), kept, promoted, ...teams.slice(ti + 1)];
}
