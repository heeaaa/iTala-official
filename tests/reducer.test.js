const M = require(process.env.ITALA_BUNDLE || '../.test-bundle.js');
const { reducer, teamBoxScore, gameScore, standings, careerStats, leagueAwards,
        perfRating, lineScore, parseRoster, leaderboards, gamesPlayedMap,
        effectiveFoulLimit, fouledOutSet, playerFouls, winPctOf, outcomeOf } = M;

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(name, a === e, `expected ${e}, got ${a}`);
}

const S0 = { leagues: [] };
const d = (state, action) => reducer(state, action);
const L = (s, id = 'lg1') => s.leagues.find(x => x.id === id);

// ===========================================================================
// GROUP A — league / team / player lifecycle
// ===========================================================================
let s = d(S0, { t: 'ADD_LEAGUE', id: 'lg1', name: 'BPBL', season: 'S3' });
ok('A1 league created', !!L(s));
eq('A2 league name/season', [L(s).name, L(s).season], ['BPBL', 'S3']);
eq('A3 league starts empty', [L(s).teams.length, L(s).players.length, L(s).games.length], [0, 0, 0]);

s = d(s, { t: 'ADD_TEAM', leagueId: 'lg1', name: 'Warriors', id: 'tH' });
s = d(s, { t: 'ADD_TEAM', leagueId: 'lg1', name: 'Bulls', id: 'tA' });
eq('A4 explicit team ids honoured', L(s).teams.map(t => t.id), ['tH', 'tA']);
ok('A5 teams get distinct colours', L(s).teams[0].color !== L(s).teams[1].color);

s = d(s, { t: 'ADD_PLAYER', leagueId: 'lg1', teamId: 'tH', name: 'Juan A', number: '17', id: 'p1' });
s = d(s, { t: 'ADD_PLAYER', leagueId: 'lg1', teamId: 'tH', name: 'Juan B', number: '09', id: 'p2' });
s = d(s, { t: 'ADD_PLAYER', leagueId: 'lg1', teamId: 'tA', name: 'Juan C', number: '7', id: 'p3' });
eq('A6 players attached to right teams',
   [L(s).teams.find(t => t.id === 'tH').playerIds, L(s).teams.find(t => t.id === 'tA').playerIds],
   [['p1', 'p2'], ['p3']]);
eq('A7 leading zero preserved', L(s).players.find(p => p.id === 'p2').number, '09');

// ADD_TEAM without explicit id still works (backward compat)
let s2 = d(s, { t: 'ADD_TEAM', leagueId: 'lg1', name: 'NoId' });
ok('A8 ADD_TEAM without id generates one', !!L(s2).teams.find(t => t.name === 'NoId')?.id);

// DELETE_PLAYER removes from team + players
let s3 = d(s, { t: 'DELETE_PLAYER', leagueId: 'lg1', teamId: 'tH', playerId: 'p2' });
ok('A9 delete player removes from roster', !L(s3).players.some(p => p.id === 'p2'));
ok('A10 delete player unlinks from team', !L(s3).teams.find(t => t.id === 'tH').playerIds.includes('p2'));

// ===========================================================================
// GROUP B — bulk import
// ===========================================================================
let sb = d(S0, { t: 'ADD_LEAGUE', id: 'lg1', name: 'BPBL', season: 'S3' });
sb = d(sb, { t: 'BULK_IMPORT_ROSTER', leagueId: 'lg1', teams: [
  { id: 'bt1', name: 'Joyboys North', players: [
    { id: 'bp1', name: 'Juan A', number: '17' }, { id: 'bp2', name: 'Juan B', number: '420' }] },
  { id: 'bt2', name: 'Philcan grind', players: [
    { id: 'bp3', name: 'Juan C', number: '09' }, { id: 'bp4', name: 'Juan D' }] },
]});
eq('B1 bulk teams created', L(sb).teams.map(t => t.name), ['Joyboys North', 'Philcan grind']);
eq('B2 bulk players created', L(sb).players.length, 4);
eq('B3 playerIds wired per team', L(sb).teams.map(t => t.playerIds), [['bp1','bp2'], ['bp3','bp4']]);
eq('B4 unusual number kept', L(sb).players.find(p => p.id === 'bp2').number, '420');
eq('B5 leading zero kept', L(sb).players.find(p => p.id === 'bp3').number, '09');
ok('B6 missing number undefined not crash', L(sb).players.find(p => p.id === 'bp4').number === undefined);
ok('B7 bulk teams get distinct colours', L(sb).teams[0].color !== L(sb).teams[1].color);

// ===========================================================================
// GROUP C — rec / drop-in game setup (the repeatedly buggy area)
// ===========================================================================
let sr = d(S0, { t: 'REC_SETUP_GAME', leagueId: 'rec-shared', gameId: 'g1',
  location: 'Southridge Gym', trackMisses: true, trackTurnovers: false,
  ensureLeague: { name: 'Community Drop-in Games (Papawis)', isShared: true },
  teams: [
    { id: 'rtA', name: 'Alpha', color: '#12D7D0', players: [{ id: 'rp1', name: 'A1', number: '1' }, { id: 'rp2', name: 'A2', number: '2' }] },
    { id: 'rtB', name: 'Bravo', color: '#C7F000', players: [{ id: 'rp3', name: 'B1', number: '3' }] },
  ]});
const rec = L(sr, 'rec-shared');
ok('C1 rec league auto-created', !!rec);
eq('C2 rec league is shared + recreational', [rec.isShared, rec.kind], [true, 'recreational']);
eq('C3 both teams created', rec.teams.map(t => t.name), ['Alpha', 'Bravo']);
eq('C4 all players created', rec.players.length, 3);
eq('C5 game is live', rec.games[0].status, 'live');
eq('C6 home/away point at the two teams', [rec.games[0].homeTeamId, rec.games[0].awayTeamId], ['rtA', 'rtB']);
eq('C7 location stored', rec.games[0].location, 'Southridge Gym');
eq('C8 per-game stat overrides stored', [rec.games[0].trackMisses, rec.games[0].trackTurnovers], [true, false]);
eq('C9 team colours honoured from draft', rec.teams.map(t => t.color), ['#12D7D0', '#C7F000']);
// every team the game references must exist (the "?" bug)
ok('C10 no dangling team refs', rec.teams.some(t => t.id === rec.games[0].homeTeamId) &&
                                rec.teams.some(t => t.id === rec.games[0].awayTeamId));
// every playerId on a team must exist in players (the vanished-player bug)
const recPlayerIds = new Set(rec.players.map(p => p.id));
ok('C11 no dangling player refs', rec.teams.every(t => t.playerIds.every(id => recPlayerIds.has(id))));

// second rec game in the SAME league must not disturb the first
let sr2 = d(sr, { t: 'REC_SETUP_GAME', leagueId: 'rec-shared', gameId: 'g2', location: 'Court 2',
  ensureLeague: { name: 'Community Drop-in Games (Papawis)', isShared: true },
  teams: [
    { id: 'rtC', name: 'Charlie', color: '#FF4D4F', players: [{ id: 'rp4', name: 'C1', number: '4' }] },
    { id: 'rtD', name: 'Delta', color: '#FFC24B', players: [{ id: 'rp5', name: 'D1', number: '5' }] },
  ]});
const rec2 = L(sr2, 'rec-shared');
eq('C12 second game added, first intact', rec2.games.length, 2);
eq('C13 all four teams coexist', rec2.teams.length, 4);
eq('C14 all five players coexist', rec2.players.length, 5);

// ===========================================================================
// GROUP D — cleanup preserves shared entities
// ===========================================================================
// g1 uses rtA/rtB, g2 uses rtC/rtD. Delete only g1 → rtA/rtB go, rtC/rtD stay.
let sc = d(sr2, { t: 'SET_GAME_STATUS', leagueId: 'rec-shared', gameId: 'g1', status: 'final' });
sc = d(sc, { t: 'CLEANUP_REC_GAMES', leagueId: 'rec-shared', gameIds: ['g1'] });
const cl = L(sc, 'rec-shared');
eq('D1 target game removed', cl.games.map(g => g.id), ['g2']);
eq('D2 orphaned teams removed', cl.teams.map(t => t.id).sort(), ['rtC', 'rtD']);
eq('D3 orphaned players removed', cl.players.map(p => p.id).sort(), ['rp4', 'rp5']);

// A team SHARED between a deleted and a surviving game must survive.
let sh = d(S0, { t: 'ADD_LEAGUE', id: 'lg1', name: 'X', season: 'S1' });
sh = d(sh, { t: 'ADD_TEAM', leagueId: 'lg1', name: 'Shared', id: 'ts' });
sh = d(sh, { t: 'ADD_TEAM', leagueId: 'lg1', name: 'Old', id: 'to' });
sh = d(sh, { t: 'ADD_TEAM', leagueId: 'lg1', name: 'New', id: 'tn' });
sh = d(sh, { t: 'ADD_PLAYER', leagueId: 'lg1', teamId: 'ts', name: 'SP', id: 'sp1' });
sh = d(sh, { t: 'CREATE_GAME', id: 'gOld', leagueId: 'lg1', homeTeamId: 'ts', awayTeamId: 'to' });
sh = d(sh, { t: 'CREATE_GAME', id: 'gNew', leagueId: 'lg1', homeTeamId: 'ts', awayTeamId: 'tn' });
sh = d(sh, { t: 'CLEANUP_REC_GAMES', leagueId: 'lg1', gameIds: ['gOld'] });
ok('D4 shared team survives cleanup', L(sh).teams.some(t => t.id === 'ts'));
ok('D5 shared team players survive', L(sh).players.some(p => p.id === 'sp1'));
ok('D6 exclusively-old team removed', !L(sh).teams.some(t => t.id === 'to'));
ok('D7 surviving-game team kept', L(sh).teams.some(t => t.id === 'tn'));

// ===========================================================================
// GROUP E — HYDRATE guard (the drop-in vanishing fix)
// ===========================================================================
// Simulate: local state has a fresh rec bundle; server snapshot lacks it.
const serverSnapshot = { leagues: [ { ...L(sr, 'rec-shared'), games: [], teams: [], players: [] } ] };
const afterHydrate = d(sr, { t: 'HYDRATE', state: serverSnapshot });
const hy = L(afterHydrate, 'rec-shared');
// NOTE: the guard is armed by dispatch(), not the raw reducer, so a raw
// reducer HYDRATE legitimately takes the server value. This test documents
// that boundary rather than asserting the guard.
ok('E1 HYDRATE runs without throwing', !!hy);
ok('E2 HYDRATE produces no app-wide settings key', !('settings' in afterHydrate));
// HYDRATE must never produce dangling references in whatever it returns
for (const lg of afterHydrate.leagues) {
  const tIds = new Set(lg.teams.map(t => t.id));
  const pIds = new Set(lg.players.map(p => p.id));
  ok(`E3 no dangling team ref after hydrate (${lg.id})`,
     lg.games.every(g => (tIds.has(g.homeTeamId) && tIds.has(g.awayTeamId)) || lg.teams.length === 0));
  ok(`E4 no dangling player ref after hydrate (${lg.id})`,
     lg.teams.every(t => t.playerIds.every(id => pIds.has(id))));
}

// ===========================================================================
// GROUP F — stats engine
// ===========================================================================
let st = d(S0, { t: 'ADD_LEAGUE', id: 'lg1', name: 'BPBL', season: 'S3' });
st = d(st, { t: 'ADD_TEAM', leagueId: 'lg1', name: 'Home', id: 'tH' });
st = d(st, { t: 'ADD_TEAM', leagueId: 'lg1', name: 'Away', id: 'tA' });
st = d(st, { t: 'ADD_PLAYER', leagueId: 'lg1', teamId: 'tH', name: 'Scorer', number: '1', id: 'p1' });
st = d(st, { t: 'ADD_PLAYER', leagueId: 'lg1', teamId: 'tH', name: 'Helper', number: '2', id: 'p2' });
st = d(st, { t: 'ADD_PLAYER', leagueId: 'lg1', teamId: 'tA', name: 'Rival', number: '3', id: 'p3' });
st = d(st, { t: 'CREATE_GAME', id: 'g1', leagueId: 'lg1', homeTeamId: 'tH', awayTeamId: 'tA' });
const ev = (teamId, playerId, type, period = 1) =>
  { st = d(st, { t: 'ADD_EVENT', leagueId: 'lg1', gameId: 'g1', teamId, playerId, type, period }); };
// p1: 3x 2pt, 2x 3pt, 1 FT = 6 + 6 + 1 = 13 pts
ev('tH','p1','fg2_make'); ev('tH','p1','fg2_make'); ev('tH','p1','fg2_make');
ev('tH','p1','fg3_make'); ev('tH','p1','fg3_make'); ev('tH','p1','ft_make');
ev('tH','p1','fg2_miss'); ev('tH','p1','fg3_miss'); ev('tH','p1','ft_miss');
// p1 rebounds/assists for a double-double check
for (let i = 0; i < 11; i++) ev('tH','p1','reb');
ev('tH','p2','ast'); ev('tH','p2','ast'); ev('tH','p2','stl'); ev('tH','p2','blk');
// away scores 5
ev('tA','p3','fg2_make'); ev('tA','p3','fg3_make');

const box = teamBoxScore(st.leagues[0], 'g1', 'tH');
const l1 = box.lines.find(x => x.playerId === 'p1');
eq('F1 points from mixed makes', l1.pts, 13);
eq('F2 FGM counts 2s and 3s', l1.fgm, 5);
eq('F3 FGA includes misses', l1.fga, 7);
eq('F4 3PM/3PA', [l1.tpm, l1.tpa], [2, 3]);
eq('F5 FTM/FTA', [l1.ftm, l1.fta], [1, 2]);
eq('F6 rebounds aggregate', l1.reb, 11);
const l2 = box.lines.find(x => x.playerId === 'p2');
eq('F7 assists/steals/blocks', [l2.ast, l2.stl, l2.blk], [2, 1, 1]);

const scr = gameScore(st.leagues[0], st.leagues[0].games[0]);
eq('F8 game score home', scr.home, 13);
eq('F9 game score away', scr.away, 5);

// double-double detection inputs (used by card specs)
ok('F10 p1 qualifies as double-double', l1.pts >= 10 && l1.reb >= 10);
ok('F11 perfRating positive for productive line', perfRating(l1) > 0);

// standings after finishing the game
st = d(st, { t: 'SET_GAME_STATUS', leagueId: 'lg1', gameId: 'g1', status: 'final' });
const tab = standings(st.leagues[0]);
const homeRow = tab.find(r => r.team.id === 'tH');
const awayRow = tab.find(r => r.team.id === 'tA');
eq('F12 winner has 1 win', [homeRow.wins, homeRow.losses], [1, 0]);
eq('F13 loser has 1 loss', [awayRow.wins, awayRow.losses], [0, 1]);
eq('F14 standings sorted winner first', tab[0].team.id, 'tH');

const cs = careerStats(st.leagues[0], 'p1');
eq('F15 games played', cs.gp, 1);
eq('F16 ppg equals single-game points', cs.ppg, 13);
eq('F17 career high tracked', cs.highPts, 13);

const gp = gamesPlayedMap(st.leagues[0]);
eq('F18 gamesPlayedMap counts p1', gp.get('p1'), 1);

// foul-out behaviour
eq('F19 foul limit capped at 5', effectiveFoulLimit({ ...st.leagues[0], foulOutLimit: 6 }), 5);
for (let i = 0; i < 5; i++) ev('tH','p2','pf');
eq('F20 playerFouls counts', playerFouls(st.leagues[0], 'g1', 'p2'), 5);
ok('F21 fouled-out set includes p2', fouledOutSet(st.leagues[0], 'g1', 'tH').has('p2'));

// leaderboards + awards
const lb = leaderboards(st.leagues[0]);
ok('F22 leaderboards returns data', !!lb);
const aw = leagueAwards(st.leagues[0]);
ok('F23 awards object returned', !!aw);
ok('F24 reboundingLeader field exists', 'reboundingLeader' in aw);

// line score
const ls = lineScore(st.leagues[0], st.leagues[0].games[0]);
ok('F25 lineScore returns periods', !!ls);

// ===========================================================================
// GROUP G — roster parser against the real-world messy sample
// ===========================================================================
const sample = `Joyboys North

1. Manly Ondiz-17
4. Ralph Salas/Emma-24
6.Kobe Feliciano-420
8.Jasper Macabulos - 6 

Philcan grind

Albert Roquero 22
Candido ynzon 09
Mark agulay 8

Tommy guns

1:Jarold James Baldia #24
8.Ghelo Manuel#14
9:Jesse Pooni # 2
10 jeffrey samantela #9

Tropang SouthRidge

1. Arnold Mercado (Arnold) #16
8. Jopet John Gutierrez(Gutierrez) #01
10. Atanasio Dayrit #78
Jun
11. Taj Dayrit#3 - Taj`;
const parsed = parseRoster(sample);
eq('G1 four teams detected', parsed.map(t => t.name),
   ['Joyboys North', 'Philcan grind', 'Tommy guns', 'Tropang SouthRidge']);
const find = (tn, nm) => parsed.find(t => t.name === tn).players.find(p => p.name === nm);
eq('G2 name-dash-number', find('Joyboys North', 'Manly Ondiz').number, '17');
eq('G3 name-space-number', find('Philcan grind', 'Albert Roquero').number, '22');
eq('G4 leading zero kept', find('Philcan grind', 'Candido ynzon').number, '09');
eq('G5 index-colon + hash', find('Tommy guns', 'Jarold James Baldia').number, '24');
eq('G6 hash with no space', find('Tommy guns', 'Ghelo Manuel').number, '14');
eq('G7 hash with space', find('Tommy guns', 'Jesse Pooni').number, '2');
eq('G8 bare index stripped', find('Tommy guns', 'jeffrey samantela').number, '9');
eq('G9 nickname in parens dropped', find('Tropang SouthRidge', 'Arnold Mercado').number, '16');
eq('G10 parens with no space dropped', find('Tropang SouthRidge', 'Jopet John Gutierrez').number, '01');
eq('G11 trailing nickname dropped', find('Tropang SouthRidge', 'Taj Dayrit').number, '3');
eq('G12 unusual number kept, NOT flagged',
   [find('Joyboys North', 'Kobe Feliciano').number, !!find('Joyboys North', 'Kobe Feliciano').flag],
   ['420', false]);
const slash = parsed[0].players.find(p => p.name.includes('/'));
ok('G13 slash name kept whole', slash && slash.name === 'Ralph Salas/Emma');
ok('G14 slash name IS flagged', !!slash.flag);
const stray = parsed[3].players.find(p => p.name === 'Jun');
ok('G15 stray line kept as flagged row, not a team', !!stray && !!stray.flag);
ok('G16 stray line did NOT become a team', !parsed.some(t => t.name === 'Jun'));
eq('G17 trailing spaces trimmed', find('Joyboys North', 'Jasper Macabulos').number, '6');

// parser feeding the reducer end to end
let sp = d(S0, { t: 'ADD_LEAGUE', id: 'lg9', name: 'Import', season: 'S1' });
let n = 0;
sp = d(sp, { t: 'BULK_IMPORT_ROSTER', leagueId: 'lg9', teams: parsed.map((t, ti) => ({
  id: `it${ti}`, name: t.name,
  players: t.players.filter(p => p.name.trim()).map(p => ({ id: `ip${n++}`, name: p.name, number: p.number || undefined })),
}))});
const imp = L(sp, 'lg9');
eq('G18 parsed roster imports cleanly', imp.teams.length, 4);
const impPlayerIds = new Set(imp.players.map(p => p.id));
ok('G19 imported roster has no dangling refs',
   imp.teams.every(t => t.playerIds.every(id => impPlayerIds.has(id))));

// ===========================================================================
// GROUP H — undo / redo, lineups, substitution
// ===========================================================================
let su = d(S0, { t: 'ADD_LEAGUE', id: 'lg1', name: 'X', season: 'S1' });
su = d(su, { t: 'ADD_TEAM', leagueId: 'lg1', name: 'H', id: 'tH' });
su = d(su, { t: 'ADD_TEAM', leagueId: 'lg1', name: 'A', id: 'tA' });
for (let i = 1; i <= 6; i++) su = d(su, { t: 'ADD_PLAYER', leagueId: 'lg1', teamId: 'tH', name: 'P'+i, id: 'hp'+i });
su = d(su, { t: 'CREATE_GAME', id: 'g1', leagueId: 'lg1', homeTeamId: 'tH', awayTeamId: 'tA' });
su = d(su, { t: 'SET_LINEUPS', leagueId: 'lg1', gameId: 'g1',
             home: ['hp1','hp2','hp3','hp4','hp5'], away: [] });
eq('H1 SET_LINEUPS writes home five', L(su).games[0].homeOnCourt, ['hp1','hp2','hp3','hp4','hp5']);
su = d(su, { t: 'SUBSTITUTE', leagueId: 'lg1', gameId: 'g1', side: 'home', outId: 'hp5', inId: 'hp6' });
ok('H2 substitution swaps players',
   L(su).games[0].homeOnCourt.includes('hp6') && !L(su).games[0].homeOnCourt.includes('hp5'));
eq('H3 on-court stays five', L(su).games[0].homeOnCourt.length, 5);

su = d(su, { t: 'ADD_EVENT', leagueId: 'lg1', gameId: 'g1', teamId: 'tH', playerId: 'hp1', type: 'fg2_make', period: 1 });
const beforeUndo = gameScore(L(su), L(su).games[0]).home;
su = d(su, { t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
const afterUndo = gameScore(L(su), L(su).games[0]).home;
eq('H4 undo removes the score', [beforeUndo, afterUndo], [2, 0]);
su = d(su, { t: 'REDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
eq('H5 redo restores the score', gameScore(L(su), L(su).games[0]).home, 2);
// Undo must be a real deletion locally so the sync layer has an id to delete
// server-side. If the event lingers, the undone stat comes back on the next pull.
let sud = d(su, { t: 'ADD_EVENT', leagueId: 'lg1', gameId: 'g1', teamId: 'tH', playerId: 'hp1', type: 'fg3_make', period: 1 });
const evCountBefore = L(sud).events.length;
sud = d(sud, { t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
eq('H7 undo removes the event row', L(sud).events.length, evCountBefore - 1);
ok('H8 undone event is on the redo stack', (L(sud)._redo?.g1 ?? []).length > 0);
sud = d(sud, { t: 'REDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
eq('H9 redo restores the event row', L(sud).events.length, evCountBefore);
eq('H10 redo stack drained', (L(sud)._redo?.g1 ?? []).length, 0);
// undo respects per-game scoping: undoing in one game must not touch another
let sg2 = d(su, { t: 'CREATE_GAME', id: 'g2', leagueId: 'lg1', homeTeamId: 'tH', awayTeamId: 'tA' });
sg2 = d(sg2, { t: 'ADD_EVENT', leagueId: 'lg1', gameId: 'g2', teamId: 'tH', playerId: 'hp1', type: 'fg2_make', period: 1 });
const g1Events = L(sg2).events.filter(e => e.gameId === 'g1').length;
sg2 = d(sg2, { t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g2' });
eq('H11 undo is scoped to its own game', L(sg2).events.filter(e => e.gameId === 'g1').length, g1Events);

// ---------------------------------------------------------------------------
// Undoing a foul-out must reverse the auto-bench, not just delete the row.
// ADD_EVENT pulls a player off the court on their limit-reaching foul, so an undo
// that leaves them benched hands the scorekeeper a player on 4 fouls who is
// mysteriously off the floor.
// ---------------------------------------------------------------------------
let sf = d(S0, { t: 'ADD_LEAGUE', id: 'lg1', name: 'X', season: 'S1' });
sf = d(sf, { t: 'ADD_TEAM', leagueId: 'lg1', name: 'H', id: 'tH' });
sf = d(sf, { t: 'ADD_TEAM', leagueId: 'lg1', name: 'A', id: 'tA' });
for (let i = 1; i <= 7; i++) sf = d(sf, { t: 'ADD_PLAYER', leagueId: 'lg1', teamId: 'tH', name: 'P'+i, id: 'hp'+i });
sf = d(sf, { t: 'CREATE_GAME', id: 'g1', leagueId: 'lg1', homeTeamId: 'tH', awayTeamId: 'tA' });
sf = d(sf, { t: 'SET_LINEUPS', leagueId: 'lg1', gameId: 'g1',
             home: ['hp1','hp2','hp3','hp4','hp5'], away: [] });
const foul = (s, pid) => d(s, { t: 'ADD_EVENT', leagueId: 'lg1', gameId: 'g1', teamId: 'tH', playerId: pid, type: 'pf', period: 1 });

let sf5 = sf;
for (let i = 0; i < 4; i++) sf5 = foul(sf5, 'hp1');
ok('H12 four fouls keep the player on court', L(sf5).games[0].homeOnCourt.includes('hp1'));
sf5 = foul(sf5, 'hp1');
ok('H13 fifth foul benches the player', !L(sf5).games[0].homeOnCourt.includes('hp1'));

let sfu = d(sf5, { t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
eq('H14 undo drops the fifth foul', playerFouls(L(sfu), 'g1', 'hp1'), 4);
ok('H15 undoing the foul-out puts the player back on court',
   L(sfu).games[0].homeOnCourt.includes('hp1'));
eq('H16 on-court is still five', L(sfu).games[0].homeOnCourt.length, 5);
ok('H17 player is no longer fouled out', !fouledOutSet(L(sfu), 'g1', 'tH').has('hp1'));

// Substitutions are not events, so someone may already have taken the fouled-out
// player's place. Restoring then would put six on the floor — it must not.
let sfsub = d(sf5, { t: 'SUBSTITUTE', leagueId: 'lg1', gameId: 'g1', side: 'home', outId: 'hp1', inId: 'hp6' });
eq('H18 replacement fills the empty slot', L(sfsub).games[0].homeOnCourt.length, 5);
sfsub = d(sfsub, { t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
eq('H19 undo never puts six on the court', L(sfsub).games[0].homeOnCourt.length, 5);
ok('H20 the replacement keeps the slot', L(sfsub).games[0].homeOnCourt.includes('hp6'));

// Undoing a foul that did NOT cause a foul-out must not change the court at all.
let sf3 = sf;
for (let i = 0; i < 3; i++) sf3 = foul(sf3, 'hp2');
const courtBefore = L(sf3).games[0].homeOnCourt;
sf3 = d(sf3, { t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
eq('H21 undoing an ordinary foul leaves the court alone', L(sf3).games[0].homeOnCourt, courtBefore);

// Undo of a non-foul event never touches the court either.
let sfn = foul(sf, 'hp3');
sfn = d(sfn, { t: 'ADD_EVENT', leagueId: 'lg1', gameId: 'g1', teamId: 'tH', playerId: 'hp3', type: 'fg2_make', period: 1 });
sfn = d(sfn, { t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
eq('H22 undoing a basket leaves the court alone',
   L(sfn).games[0].homeOnCourt, ['hp1','hp2','hp3','hp4','hp5']);

// A benched player whose foul-out is undone but who was subbed for on the AWAY
// side must not leak across sides.
let sfaway = d(sf, { t: 'ADD_PLAYER', leagueId: 'lg1', teamId: 'tA', name: 'A1', id: 'ap1' });
sfaway = d(sfaway, { t: 'SET_LINEUP', leagueId: 'lg1', gameId: 'g1', side: 'away', playerIds: ['ap1'] });
for (let i = 0; i < 5; i++) {
  sfaway = d(sfaway, { t: 'ADD_EVENT', leagueId: 'lg1', gameId: 'g1', teamId: 'tA', playerId: 'ap1', type: 'pf', period: 1 });
}
ok('H23 away player fouls out', !L(sfaway).games[0].awayOnCourt.includes('ap1'));
sfaway = d(sfaway, { t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
ok('H24 away player restored to the away court', L(sfaway).games[0].awayOnCourt.includes('ap1'));
eq('H25 home court untouched by an away undo',
   L(sfaway).games[0].homeOnCourt, ['hp1','hp2','hp3','hp4','hp5']);

// ---------------------------------------------------------------------------
// DELETE_EVENT must reverse a foul-out auto-bench exactly like UNDO_EVENT.
// Unlike undo (which only ever pops the last event), delete can remove any
// event in the log, so this also covers deleting a foul that is NOT the most
// recent one — the fix has to be based on the total foul count crossing back
// under the limit, not on "was this the last event".
// ---------------------------------------------------------------------------
const foulsOfHp1 = () => L(sf5).events.filter(e => e.playerId === 'hp1' && e.type === 'pf').map(e => e.id);

let sd = d(sf5, { t: 'DELETE_EVENT', leagueId: 'lg1', gameId: 'g1', eventId: foulsOfHp1()[4] });
eq('H26 deleting the foul-out foul drops the count', playerFouls(L(sd), 'g1', 'hp1'), 4);
ok('H27 deleting the foul-out foul restores the player to court',
   L(sd).games[0].homeOnCourt.includes('hp1'));
eq('H28 on-court is still five', L(sd).games[0].homeOnCourt.length, 5);
ok('H29 player is no longer fouled out', !fouledOutSet(L(sd), 'g1', 'tH').has('hp1'));

// Delete an EARLIER foul (not the last) from a player with fouls beyond the
// limit — count drops but stays at/above the limit, so the court must not change.
let sf6 = foul(sf5, 'hp1'); // 6th foul, still benched
const idsAt6 = L(sf6).events.filter(e => e.playerId === 'hp1' && e.type === 'pf').map(e => e.id);
let sd2 = d(sf6, { t: 'DELETE_EVENT', leagueId: 'lg1', gameId: 'g1', eventId: idsAt6[0] }); // delete the FIRST foul, not the last
eq('H30 deleting a non-final foul still drops the count', playerFouls(L(sd2), 'g1', 'hp1'), 5);
ok('H31 still at the limit, so still benched', !L(sd2).games[0].homeOnCourt.includes('hp1'));

// Deleting one more foul now crosses back under the limit — must restore,
// proving the check is driven by the running total, not "was this the last event".
const idsAt5 = L(sd2).events.filter(e => e.playerId === 'hp1' && e.type === 'pf').map(e => e.id);
let sd3 = d(sd2, { t: 'DELETE_EVENT', leagueId: 'lg1', gameId: 'g1', eventId: idsAt5[0] });
eq('H32 count drops below the limit', playerFouls(L(sd3), 'g1', 'hp1'), 4);
ok('H33 now restored to court', L(sd3).games[0].homeOnCourt.includes('hp1'));

// Deleting an ordinary (non-limit-crossing) foul must not touch the court at all.
let sf2b = sf;
for (let i = 0; i < 2; i++) sf2b = foul(sf2b, 'hp2');
const ordinaryFoulId = L(sf2b).events.filter(e => e.playerId === 'hp2' && e.type === 'pf')[0].id;
const courtBeforeDelete = L(sf2b).games[0].homeOnCourt;
let sf2bd = d(sf2b, { t: 'DELETE_EVENT', leagueId: 'lg1', gameId: 'g1', eventId: ordinaryFoulId });
eq('H34 deleting an ordinary foul leaves the court alone', L(sf2bd).games[0].homeOnCourt, courtBeforeDelete);

// Deleting a non-foul event never touches the court either.
let sfnd = foul(sf, 'hp3');
sfnd = d(sfnd, { t: 'ADD_EVENT', leagueId: 'lg1', gameId: 'g1', teamId: 'tH', playerId: 'hp3', type: 'fg2_make', period: 1 });
const basketId = L(sfnd).events.find(e => e.type === 'fg2_make').id;
sfnd = d(sfnd, { t: 'DELETE_EVENT', leagueId: 'lg1', gameId: 'g1', eventId: basketId });
eq('H35 deleting a basket leaves the court alone',
   L(sfnd).games[0].homeOnCourt, ['hp1','hp2','hp3','hp4','hp5']);

// Deleting an unknown event id is a safe no-op.
let sfx = d(sf5, { t: 'DELETE_EVENT', leagueId: 'lg1', gameId: 'g1', eventId: 'no-such-event' });
eq('H36 deleting an unknown event id is a no-op', L(sfx).events.length, L(sf5).events.length);

// SET_LINEUPS is atomic — both sides land in one action
let sa = d(su, { t: 'SET_LINEUPS', leagueId: 'lg1', gameId: 'g1', home: ['hp1'], away: ['hp2'] });
eq('H6 SET_LINEUPS atomic both sides',
   [L(sa).games[0].homeOnCourt, L(sa).games[0].awayOnCourt], [['hp1'], ['hp2']]);

// ===========================================================================
// GROUP K — redo survives background sync (regression: redo self-disabled)
// ===========================================================================
let sk = d(S0, { t: 'ADD_LEAGUE', id: 'lg1', name: 'X', season: 'S1' });
sk = d(sk, { t: 'ADD_TEAM', leagueId: 'lg1', name: 'H', id: 'tH' });
sk = d(sk, { t: 'ADD_TEAM', leagueId: 'lg1', name: 'A', id: 'tA' });
sk = d(sk, { t: 'ADD_PLAYER', leagueId: 'lg1', teamId: 'tH', name: 'P1', id: 'kp1' });
sk = d(sk, { t: 'CREATE_GAME', id: 'g1', leagueId: 'lg1', homeTeamId: 'tH', awayTeamId: 'tA' });
sk = d(sk, { t: 'ADD_EVENT', leagueId: 'lg1', gameId: 'g1', teamId: 'tH', playerId: 'kp1', type: 'fg2_make', period: 1 });
sk = d(sk, { t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
ok('K1 redo available after undo', (L(sk)._redo?.g1 ?? []).length === 1);

// A realtime pull arrives. The server snapshot NEVER carries _redo.
const serverView = { leagues: L(sk) ? [JSON.parse(JSON.stringify({ ...L(sk), _redo: undefined }))] : [], settings: { trackMisses: true } };
const afterSync = d(sk, { t: 'HYDRATE', state: serverView });
ok('K2 redo SURVIVES a background sync', (L(afterSync)._redo?.g1 ?? []).length === 1);

const redone = d(afterSync, { t: 'REDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
eq('K3 redo still works after a sync', gameScore(L(redone), L(redone).games[0]).home, 2);
eq('K4 play-by-play reflects the redone event', L(redone).events.filter(e => e.gameId === 'g1').length, 1);
eq('K5 play-by-play reflects the undo', L(afterSync).events.filter(e => e.gameId === 'g1').length, 0);

// Standard semantics: a NEW event clears the redo stack.
let sk2 = d(sk, { t: 'ADD_EVENT', leagueId: 'lg1', gameId: 'g1', teamId: 'tH', playerId: 'kp1', type: 'fg3_make', period: 1 });
eq('K6 new event clears the redo stack', (L(sk2)._redo?.g1 ?? []).length, 0);

// Repeated undo/redo cycles stay consistent.
let sk3 = sk;
for (let i = 0; i < 3; i++) {
  sk3 = d(sk3, { t: 'REDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  sk3 = d(sk3, { t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
}
eq('K7 repeated undo/redo cycles stay consistent', L(sk3).events.filter(e => e.gameId === 'g1').length, 0);
eq('K8 redo stack still holds one event', (L(sk3)._redo?.g1 ?? []).length, 1);

// ===========================================================================
// GROUP L — community drop-in games record their creator (creator-only scoring)
// ===========================================================================
let sl = d(S0, { t: 'REC_SETUP_GAME', leagueId: 'rec-shared', gameId: 'gc1',
  location: 'Gym', createdBy: 'user-A',
  ensureLeague: { name: 'Community Drop-in Games (Papawis)', isShared: true },
  teams: [
    { id: 'lA', name: 'Alpha', color: '#12D7D0', players: [{ id: 'lp1', name: 'A', number: '1' }] },
    { id: 'lB', name: 'Bravo', color: '#C7F000', players: [{ id: 'lp2', name: 'B', number: '2' }] },
  ]});
const comm = L(sl, 'rec-shared');
eq('L1 creator stamped on the game', comm.games[0].createdBy, 'user-A');
eq('L2 community space is shared', comm.isShared, true);

// A second creator's game in the same shared space keeps its own creator.
sl = d(sl, { t: 'REC_SETUP_GAME', leagueId: 'rec-shared', gameId: 'gc2',
  location: 'Gym 2', createdBy: 'user-B',
  ensureLeague: { name: 'Community Drop-in Games (Papawis)', isShared: true },
  teams: [
    { id: 'lC', name: 'Charlie', color: '#FF4D4F', players: [{ id: 'lp3', name: 'C', number: '3' }] },
    { id: 'lD', name: 'Delta', color: '#FFC24B', players: [{ id: 'lp4', name: 'D', number: '4' }] },
  ]});
const comm2 = L(sl, 'rec-shared');
eq('L3 each game keeps its own creator',
   comm2.games.map(g => g.createdBy).sort(), ['user-A', 'user-B']);

// Private spaces record the creator too (harmless, and useful for display).
let slp = d(S0, { t: 'REC_SETUP_GAME', leagueId: 'rec-mine', gameId: 'gp1',
  location: 'Court', createdBy: 'user-A',
  ensureLeague: { name: 'Private Drop-In Games', isShared: false },
  teams: [
    { id: 'pA', name: 'A', color: '#12D7D0', players: [{ id: 'pp1', name: 'A', number: '1' }] },
    { id: 'pB', name: 'B', color: '#C7F000', players: [{ id: 'pp2', name: 'B', number: '2' }] },
  ]});
eq('L4 private space records creator', L(slp, 'rec-mine').games[0].createdBy, 'user-A');
ok('L5 private space is not shared (falsy)', !L(slp, 'rec-mine').isShared);

// Backward compatible: no createdBy supplied still works (legacy call sites).
let sln = d(S0, { t: 'REC_SETUP_GAME', leagueId: 'rec-x', gameId: 'gx1', location: 'X',
  ensureLeague: { name: 'Private Drop-In Games', isShared: false },
  teams: [
    { id: 'xA', name: 'A', color: '#12D7D0', players: [{ id: 'xp1', name: 'A', number: '1' }] },
    { id: 'xB', name: 'B', color: '#C7F000', players: [{ id: 'xp2', name: 'B', number: '2' }] },
  ]});
ok('L6 missing createdBy does not break setup', !!L(sln, 'rec-x')?.games[0]);
eq('L7 missing createdBy is undefined, not null', L(sln, 'rec-x').games[0].createdBy, undefined);

// ===========================================================================
// GROUP I — immutability (state is never mutated in place)
// ===========================================================================
const frozen = d(S0, { t: 'ADD_LEAGUE', id: 'lgz', name: 'Z', season: 'S1' });
const snapshot = JSON.stringify(frozen);
d(frozen, { t: 'ADD_TEAM', leagueId: 'lgz', name: 'Mutant', id: 'tm' });
eq('I1 previous state not mutated by ADD_TEAM', JSON.stringify(frozen), snapshot);
d(frozen, { t: 'DELETE_LEAGUE', leagueId: 'lgz' });
eq('I2 previous state not mutated by DELETE_LEAGUE', JSON.stringify(frozen), snapshot);

// ===========================================================================
// GROUP J — defensive: unknown league / game ids must not throw
// ===========================================================================
try { d(S0, { t: 'ADD_TEAM', leagueId: 'nope', name: 'X' }); ok('J1 ADD_TEAM unknown league no throw', true); }
catch (e) { ok('J1 ADD_TEAM unknown league no throw', false, e.message); }
try { d(S0, { t: 'ADD_EVENT', leagueId: 'nope', gameId: 'nope', teamId: 't', playerId: 'p', type: 'fg2_make', period: 1 });
      ok('J2 ADD_EVENT unknown ids no throw', true); }
catch (e) { ok('J2 ADD_EVENT unknown ids no throw', false, e.message); }
try { d(S0, { t: 'CLEANUP_REC_GAMES', leagueId: 'nope', gameIds: ['x'] }); ok('J3 CLEANUP unknown league no throw', true); }
catch (e) { ok('J3 CLEANUP unknown league no throw', false, e.message); }
try { const empty = teamBoxScore(L(d(S0, { t: 'ADD_LEAGUE', id: 'lq', name: 'q', season: 's' }), 'lq'), 'nogame', 'noteam');
      ok('J4 teamBoxScore unknown game no throw', !!empty); }
catch (e) { ok('J4 teamBoxScore unknown game no throw', false, e.message); }
try { const g = { id: 'x', leagueId: 'lq', homeTeamId: 'a', awayTeamId: 'b', status: 'live', homeOnCourt: [], awayOnCourt: [] };
      gameScore(L(d(S0, { t: 'ADD_LEAGUE', id: 'lq', name: 'q', season: 's' }), 'lq'), g);
      ok('J5 gameScore missing teams no throw', true); }
catch (e) { ok('J5 gameScore missing teams no throw', false, e.message); }
try { parseRoster(''); ok('J6 parseRoster empty no throw', true); }
catch (e) { ok('J6 parseRoster empty no throw', false, e.message); }
try { const r = parseRoster('JustANameNoNumbers'); ok('J7 parseRoster single line no throw', Array.isArray(r)); }
catch (e) { ok('J7 parseRoster single line no throw', false, e.message); }
try { careerStats(L(d(S0, { t: 'ADD_LEAGUE', id: 'lq', name: 'q', season: 's' }), 'lq'), 'ghost');
      ok('J8 careerStats unknown player no throw', true); }
catch (e) { ok('J8 careerStats unknown player no throw', false, e.message); }
try { leagueAwards(L(d(S0, { t: 'ADD_LEAGUE', id: 'lq', name: 'q', season: 's' }), 'lq'));
      ok('J9 leagueAwards empty league no throw', true); }
catch (e) { ok('J9 leagueAwards empty league no throw', false, e.message); }
try { standings(L(d(S0, { t: 'ADD_LEAGUE', id: 'lq', name: 'q', season: 's' }), 'lq'));
      ok('J10 standings empty league no throw', true); }
catch (e) { ok('J10 standings empty league no throw', false, e.message); }

// ===========================================================================
// GROUP N — legacy app-wide trackMisses migration. Before leagues.track_misses
// existed, one global toggle governed every league on every device. The column
// replaced it and the global is now gone, but a device upgrading from an older
// build still carries the old value in its saved state, so HYDRATE reads it
// once to seed leagues that predate the column. Getting this wrong silently
// flips a scorekeeper's setting back on for every pre-migration league.
// ===========================================================================
const legacyLeague = (id, extra = {}) => ({
  id, name: 'Legacy', season: 'S1',
  teams: [], players: [], games: [], events: [], createdAt: 1,
  ...extra,
});
const hydrateLegacy = (leagues, settings) =>
  d(S0, { t: 'HYDRATE', state: settings === undefined ? { leagues } : { leagues, settings } });

// The case that matters. A scorekeeper who turned misses OFF must not have them
// turned back on by the upgrade.
const nFalse = hydrateLegacy([legacyLeague('lgN1')], { trackMisses: false });
eq('N1 legacy false seeds a pre-migration league', L(nFalse, 'lgN1').trackMisses, false);

const nTrue = hydrateLegacy([legacyLeague('lgN2')], { trackMisses: true });
eq('N2 legacy true seeds a pre-migration league', L(nTrue, 'lgN2').trackMisses, true);

// An explicit per-league value always wins over the legacy global, in both
// directions - the column is the source of truth once it is set.
const nExplicitTrue = hydrateLegacy([legacyLeague('lgN3', { trackMisses: true })], { trackMisses: false });
eq('N3 explicit per-league true beats a legacy false', L(nExplicitTrue, 'lgN3').trackMisses, true);

const nExplicitFalse = hydrateLegacy([legacyLeague('lgN4', { trackMisses: false })], { trackMisses: true });
eq('N4 explicit per-league false beats a legacy true', L(nExplicitFalse, 'lgN4').trackMisses, false);

// The normal case from now on: no legacy key at all.
const nNone = hydrateLegacy([legacyLeague('lgN5')], undefined);
eq('N5 missing legacy key defaults to true', L(nNone, 'lgN5').trackMisses, true);

// The global must not come back into state by any route.
ok('N6 HYDRATE produces no settings key', !('settings' in nFalse));
ok('N7 an ordinary action produces no settings key',
   !('settings' in d(S0, { t: 'ADD_LEAGUE', id: 'lgN6', name: 'x', season: 'y' })));

// trackTurnovers never had a global, so the migration must leave it untouched
// rather than inventing a value for it.
eq('N8 trackTurnovers untouched by the legacy migration',
   L(nFalse, 'lgN1').trackTurnovers, undefined);
// GROUP M — tied final scores (F-11). A level game used to resolve as a home
// win, because every winner check was `home >= away`. That silently credited
// the home side a win and the away side a loss, which then flowed into win%,
// streaks, top-5 award eligibility and standings[0] as "Champion". A 0-0 game
// marked final took the same path, so this was reachable without anybody
// mis-tapping anything.
// ===========================================================================
let mt = d(S0, { t: 'ADD_LEAGUE', id: 'lgT', name: 'Ties', season: 'S1' });
mt = d(mt, { t: 'ADD_TEAM', leagueId: 'lgT', name: 'Home', id: 'mH' });
mt = d(mt, { t: 'ADD_TEAM', leagueId: 'lgT', name: 'Away', id: 'mA' });
mt = d(mt, { t: 'ADD_PLAYER', leagueId: 'lgT', teamId: 'mH', name: 'H1', number: '1', id: 'mp1' });
mt = d(mt, { t: 'ADD_PLAYER', leagueId: 'lgT', teamId: 'mA', name: 'A1', number: '2', id: 'mp2' });
mt = d(mt, { t: 'CREATE_GAME', id: 'gT', leagueId: 'lgT', homeTeamId: 'mH', awayTeamId: 'mA' });
const evT = (teamId, playerId, type, period = 1) =>
  { mt = d(mt, { t: 'ADD_EVENT', leagueId: 'lgT', gameId: 'gT', teamId, playerId, type, period }); };
// 6-6: three 2-pointers each.
evT('mH', 'mp1', 'fg2_make'); evT('mH', 'mp1', 'fg2_make'); evT('mH', 'mp1', 'fg2_make');
evT('mA', 'mp2', 'fg2_make'); evT('mA', 'mp2', 'fg2_make'); evT('mA', 'mp2', 'fg2_make');
mt = d(mt, { t: 'SET_GAME_STATUS', leagueId: 'lgT', gameId: 'gT', status: 'final' });

const tieScore = gameScore(L(mt, 'lgT'), L(mt, 'lgT').games[0]);
eq('M1 fixture really is tied', [tieScore.home, tieScore.away], [6, 6]);

const tt = standings(L(mt, 'lgT'));
const tH = tt.find(r => r.team.id === 'mH');
const tA = tt.find(r => r.team.id === 'mA');
eq('M2 tie credits the home team no win', [tH.wins, tH.losses], [0, 0]);
eq('M3 tie credits the away team no loss', [tA.wins, tA.losses], [0, 0]);
eq('M4 tie counted as a tie for both sides', [tH.ties, tA.ties], [1, 1]);
eq('M5 tie shows as T in the streak', [tH.streak, tA.streak], ['T1', 'T1']);
eq('M6 tie is half a win in win%', winPctOf(tH.wins, tH.losses, tH.ties), 0.5);
eq('M7 points for/against still recorded on a tie', [tH.pf, tH.pa, tA.pf, tA.pa], [6, 6, 6, 6]);

// The win% ordering a tie has to sit inside: better than a loss, worse than a win.
eq('M8 win% orders win > tie > loss',
   [winPctOf(1, 0, 0), winPctOf(0, 0, 1), winPctOf(0, 1, 0)], [1, 0.5, 0]);
eq('M9 winPctOf stays backward compatible with two arguments', winPctOf(1, 1), 0.5);
eq('M10 winPctOf with no games played is 0', winPctOf(0, 0, 0), 0);

// A 0-0 game marked final is the same bug reached with no events at all.
let mz = d(S0, { t: 'ADD_LEAGUE', id: 'lgZ', name: 'Zero', season: 'S1' });
mz = d(mz, { t: 'ADD_TEAM', leagueId: 'lgZ', name: 'Home', id: 'zH' });
mz = d(mz, { t: 'ADD_TEAM', leagueId: 'lgZ', name: 'Away', id: 'zA' });
mz = d(mz, { t: 'CREATE_GAME', id: 'gZ', leagueId: 'lgZ', homeTeamId: 'zH', awayTeamId: 'zA' });
mz = d(mz, { t: 'SET_GAME_STATUS', leagueId: 'lgZ', gameId: 'gZ', status: 'final' });
const zt = standings(L(mz, 'lgZ'));
eq('M11 0-0 final is not a home win',
   [zt.find(r => r.team.id === 'zH').wins, zt.find(r => r.team.id === 'zA').losses], [0, 0]);
eq('M12 0-0 final counts as a tie', zt.find(r => r.team.id === 'zH').ties, 1);

// Characterisation: a decided game must behave exactly as it did before.
let md = d(S0, { t: 'ADD_LEAGUE', id: 'lgD', name: 'Decided', season: 'S1' });
md = d(md, { t: 'ADD_TEAM', leagueId: 'lgD', name: 'Home', id: 'dH' });
md = d(md, { t: 'ADD_TEAM', leagueId: 'lgD', name: 'Away', id: 'dA' });
md = d(md, { t: 'ADD_PLAYER', leagueId: 'lgD', teamId: 'dA', name: 'A1', number: '1', id: 'dp1' });
md = d(md, { t: 'CREATE_GAME', id: 'gD', leagueId: 'lgD', homeTeamId: 'dH', awayTeamId: 'dA' });
md = d(md, { t: 'ADD_EVENT', leagueId: 'lgD', gameId: 'gD', teamId: 'dA', playerId: 'dp1', type: 'fg2_make', period: 1 });
md = d(md, { t: 'SET_GAME_STATUS', leagueId: 'lgD', gameId: 'gD', status: 'final' });
const dt = standings(L(md, 'lgD'));
const dA = dt.find(r => r.team.id === 'dA');
const dH = dt.find(r => r.team.id === 'dH');
eq('M13 away win still recorded as a win', [dA.wins, dA.losses, dA.ties], [1, 0, 0]);
eq('M14 home loss still recorded as a loss', [dH.wins, dH.losses, dH.ties], [0, 1, 0]);
eq('M15 decided game still sorts the winner first', dt[0].team.id, 'dA');
eq('M16 streaks unchanged for decided games', [dA.streak, dH.streak], ['W1', 'L1']);

// outcomeOf is the single place the winner is decided, replacing the inline
// `home >= away` that five call sites had each copied.
eq('M17 outcomeOf reports a home win', outcomeOf(10, 5), 'home');
eq('M18 outcomeOf reports an away win', outcomeOf(5, 10), 'away');
eq('M19 outcomeOf reports a tie', outcomeOf(7, 7), 'tie');
eq('M20 outcomeOf treats 0-0 as a tie, not a home win', outcomeOf(0, 0), 'tie');
eq('M21 outcomeOf never reports a winner on equal scores',
   [outcomeOf(1, 1), outcomeOf(99, 99)], ['tie', 'tie']);


// ===========================================================================
console.log('='.repeat(64));
console.log(`REGRESSION SUITE:  ${pass} passed,  ${fail} failed`);
if (failures.length) {
  console.log('-'.repeat(64));
  failures.forEach(f => console.log('  FAIL  ' + f));
}
console.log('='.repeat(64));
process.exit(fail ? 1 : 0);
