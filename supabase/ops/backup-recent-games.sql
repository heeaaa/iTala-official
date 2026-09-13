-- =============================================================================
-- iTala - backup of every game that happened in the last 24 hours
-- =============================================================================
-- Run this in the Supabase SQL Editor (Project -> SQL -> New query), as the
-- default `postgres` role. That role bypasses RLS, which is required here: the
-- read_all_* policies would otherwise hide rows, and roster_import_receipts /
-- rec_setup_receipts carry `revoke all ... from anon, authenticated`, so they
-- are unreadable to any app session at all.
--
-- READ-ONLY. Nothing in this file writes to the database. PART 4 *generates the
-- text* of a restore script; it does not run it.
--
-- Five parts, each an independently runnable query:
--
--   PART 0  Schema drift guard - run this first, every time.
--   PART 1  Scope summary - how many rows, and roughly how big the output is.
--   PART 2  The plain SELECTs - look at the actual records in scope.
--   PART 3  Restore preflight - the auth.users rows a restore depends on.
--   PART 4  The generator - emits the INSERT statements to save as the backup.
--
-- To produce the dated backup file, run PART 4, use the SQL Editor's
-- "Download CSV" on the result, then:
--
--   node supabase/ops/write-backup-file.js <downloaded.csv>
--
-- which writes backup-YYYY-MM-DD.sql in the current directory. That step is not
-- cosmetic: the CSV download wraps each statement in CSV quoting and doubles the
-- apostrophes inside it, so the raw download is NOT runnable SQL. The converter
-- unwraps it and refuses to write a truncated result.
--
-- -----------------------------------------------------------------------------
-- WHAT "HAPPENED IN THE LAST 24 HOURS" MEANS HERE
-- -----------------------------------------------------------------------------
-- A game is in scope if ANY of these falls inside the window:
--
--   games.updated_at    - the row was touched (a score correction, a finish, or
--                         the game being created). This is why a game scheduled
--                         for NEXT week but created today is in scope: the row
--                         changed in the window. That is deliberate - a backup
--                         that silently drops a row is worse than one carrying a
--                         row you did not need.
--   games.finished_at   - the game was finished (client Date.now(), epoch MS)
--   games.scheduled_at  - tip-off was in the window (epoch MS)
--   events.created_at   - stats arrived for it, on the server's clock
--
-- The last one matters more than it looks. Live scoring deliberately survives a
-- connection loss: a tap that fails to push is pinned locally and replayed from
-- the outbox later (src/sync/pendingEvents.ts). So events belonging to a game
-- finished two days ago can land inside this window, and that predicate is what
-- pulls the game back in so the late taps are captured.
--
-- The same mechanism is a hazard in the other direction: a game finished sixty
-- seconds ago may still be missing its last few baskets. If the backup has to be
-- complete, run it with some lag, or run it twice and confirm the event count in
-- PART 1 has stopped moving. See the "WHAT A ROW ACTUALLY PROMISES" note above
-- final_game_scores in supabase/schema.sql - the same caveat applies.
--
-- -----------------------------------------------------------------------------
-- SETTINGS - the only two things you should need to edit
-- -----------------------------------------------------------------------------
-- Both live in the `params` CTE that opens PARTS 1-4. Edit them identically in
-- every part you run, or the parts will disagree with each other.
--
--   interval '24 hours'    the window. '48 hours', '7 days', whatever you need.
--
--   include_whole_league   true  (default) - back up EVERY team and player in
--                                any league that had a game, so the restored
--                                league has a complete roster rather than only
--                                the players who happened to appear.
--                          false - back up only the teams and players actually
--                                referenced by the games in scope.
--
--                          Note what this does NOT give you either way: correct
--                          standings. Those are computed from the whole season's
--                          games, and this backup only ever holds the games in
--                          the window. A restored league is complete as a
--                          ROSTER, not as a season.
--
--                          Set this false if a single drop-in game pulled in a
--                          large shared community league (leagues.is_shared).
--                          PART 1 shows you when that has happened: a team or
--                          player count far out of proportion to the game count.
--
-- -----------------------------------------------------------------------------
-- WHAT IS AND IS NOT INCLUDED
-- -----------------------------------------------------------------------------
-- Included:  leagues, teams, players, games, events,
--            roster_import_receipts, rec_setup_receipts
--
-- Deliberately excluded:
--
--   final_game_scores  - a VIEW, not a table. It is derived from games + events
--                        and reappears on its own once those are restored.
--                        Backing it up would create a second, staler copy of the
--                        score that could disagree with the events it came from.
--
--   league_codes,      - live join codes and single-use creation codes. These
--   creation_codes       are access credentials in plaintext: anyone holding the
--                        backup file could join the league as an owner. They are
--                        not game data and are not needed to restore a game.
--
--   league_members     - account data (auth.users UUIDs), not game data. Add it
--                        only if you are restoring into a database where the
--                        memberships are also gone. Know the consequence: a
--                        league restored without its members has no owner and no
--                        scorekeeper, so nobody but a Super Admin can write to
--                        it until membership is put back. Fine when restoring
--                        into the live project, where the memberships never
--                        left; not fine when rebuilding a project from scratch.
--
--   content_reports    - a report can name an in-scope game (record_type
--                        'game'), so it is arguably related. Left out anyway:
--                        the queue is not game data, it has its own retention
--                        rules, and because this backup only ever ADDS missing
--                        rows, a restore never needs the report to exist.
--
--   profiles,          - user accounts and PII. Out of scope for a game backup.
--   admin_emails,
--   legal_acceptances
--
--   content_reports    - moderation queue, with its own retention rules (see the
--                        long comment on that table in schema.sql).
--
-- -----------------------------------------------------------------------------
-- RESTORING
-- -----------------------------------------------------------------------------
-- The generated script is wrapped in begin/commit and every statement ends in
-- `on conflict ... do nothing`, so it:
--
--   * restores only the rows that are missing
--   * never overwrites a row that is newer than the backup
--   * is safe to run more than once
--   * is all-or-nothing - any failure rolls the whole thing back
--
-- If you want the backup to WIN over what is live instead, you have to change
-- the conflict clauses to `do update set ...` by hand. That is left manual on
-- purpose: it is the destructive choice, and it should be a decision rather than
-- a default.
--
-- Run the restore as `postgres` too. RLS write policies block most of these
-- inserts for any other role.
--
-- If you restore through psql on Windows rather than the SQL Editor, set
-- PGCLIENTENCODING=UTF8 first. psql picks its client encoding from the console
-- codepage, which can come up WIN1252, and the restore then dies partway with
--
--   character with byte sequence 0x8f in encoding "WIN1252" has no equivalent
--   in encoding "UTF8"
--
-- iTala data reaches that condition easily - a macron in a te reo team or venue
-- name, or an emoji in a drop-in league name, is enough. The generated file is
-- valid UTF-8; it is the client that misreads it. The SQL Editor is UTF-8 end to
-- end and is unaffected.
--
-- Before restoring, run PART 3. Three columns are foreign keys into auth.users:
--   games.created_by                 (on delete set null)
--   roster_import_receipts.actor_id  (not null, on delete cascade)
--   rec_setup_receipts.actor_id      (not null, on delete cascade)
-- If one of those accounts has been deleted since the backup was taken, the
-- insert fails and the whole transaction rolls back. PART 3 tells you which ones
-- before you find out the hard way.
-- =============================================================================


-- =============================================================================
-- PART 0 - SCHEMA DRIFT GUARD
-- =============================================================================
-- This script writes explicit column lists. That is readable and reviewable, but
-- it means a column added to schema.sql later would be silently dropped from
-- every backup taken afterwards - the kind of failure you only discover at
-- restore time.
--
-- This query compares the columns the script writes against the columns that
-- actually exist. ZERO ROWS = in sync. Any row returned means PART 4 must be
-- updated before you trust its output. Run it every time.

with expected(tbl, cols) as (
  values
    ('leagues', array[
       'id','name','season','kind','foul_out_limit','track_misses',
       'track_turnovers','is_shared','is_closed','is_archived',
       'created_at','updated_at']),
    ('teams', array[
       'id','league_id','name','color','coach','logo','team_only',
       'player_ids','updated_at']),
    ('players', array[
       'id','league_id','name','number','origin_player_id','updated_at']),
    ('games', array[
       'id','league_id','home_team_id','away_team_id','status','scheduled_at',
       'location','finished_at','home_on_court','away_on_court','period',
       'attendance','track_misses','track_turnovers','created_by','updated_at']),
    ('events', array[
       'id','league_id','game_id','team_id','player_id','type','period','ts',
       'note','created_at']),
    ('roster_import_receipts', array[
       'import_id','league_id','actor_id','payload','team_count','player_count',
       'created_at']),
    ('rec_setup_receipts', array[
       'game_id','league_id','actor_id','payload'])
),
exp as (select tbl, unnest(cols) as col from expected),
act as (
  select c.table_name::text as tbl, c.column_name::text as col
    from information_schema.columns c
   where c.table_schema = 'public'
     and c.table_name in (select tbl from expected)
)
select coalesce(a.tbl, e.tbl) as table_name,
       coalesce(a.col, e.col) as column_name,
       case
         when e.col is null then 'DRIFT: column exists in the database but PART 4 does not back it up'
         when a.col is null then 'DRIFT: PART 4 writes this column but the database does not have it'
       end as problem
  from act a
  full join exp e on e.tbl = a.tbl and e.col = a.col
 where a.col is null or e.col is null
 order by 1, 2;


-- =============================================================================
-- PART 1 - SCOPE SUMMARY
-- =============================================================================
-- How much data the window caught, and roughly how large the generated script
-- will be. Check the size before running PART 4: teams.logo holds base64 data
-- URIs, so a handful of teams with logos can dominate the output.

with
  params as (
    select now() - interval '24 hours' as since,
           now()                       as until,
           true                        as include_whole_league
  ),
  win as (
    select since, until, include_whole_league,
           (extract(epoch from since) * 1000)::bigint as since_ms,
           (extract(epoch from until) * 1000)::bigint as until_ms
      from params
  ),
  scoped_games as (
    select g.*
      from public.games g
     cross join win w
     where g.updated_at   between w.since    and w.until
        or g.finished_at  between w.since_ms and w.until_ms
        or g.scheduled_at between w.since_ms and w.until_ms
        or exists (select 1 from public.events e
                    where e.game_id = g.id
                      and e.created_at between w.since and w.until)
  ),
  base_leagues as (
    select l.* from public.leagues l
     where l.id in (select league_id from scoped_games)
  ),
  scoped_events as (
    select e.* from public.events e
     where e.game_id in (select id from scoped_games)
  ),
  -- Teams are matched by id as well as by league because games.home_team_id /
  -- away_team_id and events.team_id carry NO foreign key to teams (this is why
  -- the final_game_scores view joins them with LEFT joins). A team referenced by
  -- a game comes across whether or not the whole-league switch is on.
  scoped_teams as (
    select t.* from public.teams t cross join win w
     where (w.include_whole_league and t.league_id in (select id from base_leagues))
        or t.id in (select home_team_id from scoped_games)
        or t.id in (select away_team_id from scoped_games)
        or t.id in (select team_id from scoped_events)
  ),
  -- Players likewise: referenced from events.player_id and from three text[]
  -- columns (teams.player_ids, games.attendance, games.home/away_on_court). A
  -- roster id appearing only in one of those arrays still has to come across, or
  -- the restored lineup points at nothing.
  referenced_player_ids as (
    select u as id from scoped_teams t, unnest(t.player_ids) u
    union
    select u from scoped_games g,
      unnest(coalesce(g.attendance, '{}'::text[]) || g.home_on_court || g.away_on_court) u
    union
    select e.player_id from scoped_events e where e.player_id is not null
  ),
  scoped_players as (
    select p.* from public.players p cross join win w
     where (w.include_whole_league and p.league_id in (select id from base_leagues))
        or p.id in (select id from referenced_player_ids)
  ),
  -- Time-scoped: an import that ran last month is not part of "what happened in
  -- the last 24 hours", and the players it created are already covered by
  -- scoped_players above.
  scoped_roster_receipts as (
    select r.* from public.roster_import_receipts r cross join win w
     where r.league_id in (select id from base_leagues)
       and r.created_at between w.since and w.until
  ),
  -- Keyed by game_id, so scoping to the games in window is already exact. No
  -- time filter needed, and the table has no created_at to filter on anyway.
  scoped_rec_receipts as (
    select s.* from public.rec_setup_receipts s
     where s.game_id in (select id from scoped_games)
  ),
  -- THE LEAGUE CLOSURE, and the reason base_leagues above is kept separate.
  --
  -- teams.league_id, players.league_id, events.league_id and
  -- rec_setup_receipts.league_id are every one of them a foreign key to leagues.
  -- Teams and players are collected BY ID above, because games.home_team_id,
  -- games.away_team_id and events.team_id carry no foreign key at all - so a row
  -- the backup carries can belong to a league that had no game in the window.
  --
  -- Deriving the league list from the games alone left that league out, and the
  -- restore then died on teams_league_id_fkey and rolled back EVERY row: a
  -- backup file that restores nothing. So the list is closed over what is
  -- actually being written, not over what started the search.
  --
  -- Only the league ROW is added. Its roster is not expanded, even when
  -- include_whole_league is true - it is here to satisfy a foreign key, not
  -- because anything happened in it.
  scoped_leagues as (
    select l.* from public.leagues l
     where l.id in (select league_id from scoped_games)
        or l.id in (select league_id from scoped_teams)
        or l.id in (select league_id from scoped_players)
        or l.id in (select league_id from scoped_events)
        or l.id in (select league_id from scoped_rec_receipts)
        or l.id in (select league_id from scoped_roster_receipts)
  ),
  counts(sort_key, label, n) as (
              select 1, 'leagues',                    count(*) from scoped_leagues
    union all select 2, 'teams',                      count(*) from scoped_teams
    union all select 3, 'players',                    count(*) from scoped_players
    union all select 4, 'games',                      count(*) from scoped_games
    union all select 5, 'events',                     count(*) from scoped_events
    union all select 6, 'roster_import_receipts',     count(*) from scoped_roster_receipts
    union all select 7, 'rec_setup_receipts',         count(*) from scoped_rec_receipts
    union all select 8, 'games still LIVE (not final - may still be scoring)',
                        count(*) from scoped_games where status = 'live'
    union all select 9, 'approx generated script size, KB',
              ((select coalesce(sum(length(t::text)), 0) from scoped_leagues t)
             + (select coalesce(sum(length(t::text)), 0) from scoped_teams t)
             + (select coalesce(sum(length(t::text)), 0) from scoped_players t)
             + (select coalesce(sum(length(t::text)), 0) from scoped_games t)
             + (select coalesce(sum(length(t::text)), 0) from scoped_events t)
             + (select coalesce(sum(length(t::text)), 0) from scoped_roster_receipts t)
             + (select coalesce(sum(length(t::text)), 0) from scoped_rec_receipts t)
              ) / 1024
  )
select label, n from counts order by sort_key;


-- =============================================================================
-- PART 2 - THE PLAIN SELECTS
-- =============================================================================
-- The actual records, so you can see what is in scope before generating
-- anything. The query below ends with `select * from scoped_games`; swap that
-- last line for any of the alternatives listed underneath it.

with
  params as (
    select now() - interval '24 hours' as since,
           now()                       as until,
           true                        as include_whole_league
  ),
  win as (
    select since, until, include_whole_league,
           (extract(epoch from since) * 1000)::bigint as since_ms,
           (extract(epoch from until) * 1000)::bigint as until_ms
      from params
  ),
  scoped_games as (
    select g.*
      from public.games g
     cross join win w
     where g.updated_at   between w.since    and w.until
        or g.finished_at  between w.since_ms and w.until_ms
        or g.scheduled_at between w.since_ms and w.until_ms
        or exists (select 1 from public.events e
                    where e.game_id = g.id
                      and e.created_at between w.since and w.until)
  ),
  base_leagues as (
    select l.* from public.leagues l
     where l.id in (select league_id from scoped_games)
  ),
  scoped_events as (
    select e.* from public.events e
     where e.game_id in (select id from scoped_games)
  ),
  scoped_teams as (
    select t.* from public.teams t cross join win w
     where (w.include_whole_league and t.league_id in (select id from base_leagues))
        or t.id in (select home_team_id from scoped_games)
        or t.id in (select away_team_id from scoped_games)
        or t.id in (select team_id from scoped_events)
  ),
  referenced_player_ids as (
    select u as id from scoped_teams t, unnest(t.player_ids) u
    union
    select u from scoped_games g,
      unnest(coalesce(g.attendance, '{}'::text[]) || g.home_on_court || g.away_on_court) u
    union
    select e.player_id from scoped_events e where e.player_id is not null
  ),
  scoped_players as (
    select p.* from public.players p cross join win w
     where (w.include_whole_league and p.league_id in (select id from base_leagues))
        or p.id in (select id from referenced_player_ids)
  ),
  scoped_roster_receipts as (
    select r.* from public.roster_import_receipts r cross join win w
     where r.league_id in (select id from base_leagues)
       and r.created_at between w.since and w.until
  ),
  scoped_rec_receipts as (
    select s.* from public.rec_setup_receipts s
     where s.game_id in (select id from scoped_games)
  ),
  -- THE LEAGUE CLOSURE, and the reason base_leagues above is kept separate.
  --
  -- teams.league_id, players.league_id, events.league_id and
  -- rec_setup_receipts.league_id are every one of them a foreign key to leagues.
  -- Teams and players are collected BY ID above, because games.home_team_id,
  -- games.away_team_id and events.team_id carry no foreign key at all - so a row
  -- the backup carries can belong to a league that had no game in the window.
  --
  -- Deriving the league list from the games alone left that league out, and the
  -- restore then died on teams_league_id_fkey and rolled back EVERY row: a
  -- backup file that restores nothing. So the list is closed over what is
  -- actually being written, not over what started the search.
  --
  -- Only the league ROW is added. Its roster is not expanded, even when
  -- include_whole_league is true - it is here to satisfy a foreign key, not
  -- because anything happened in it.
  scoped_leagues as (
    select l.* from public.leagues l
     where l.id in (select league_id from scoped_games)
        or l.id in (select league_id from scoped_teams)
        or l.id in (select league_id from scoped_players)
        or l.id in (select league_id from scoped_events)
        or l.id in (select league_id from scoped_rec_receipts)
        or l.id in (select league_id from scoped_roster_receipts)
  )
-- ---- pick ONE of these ------------------------------------------------------
select * from scoped_games order by coalesce(finished_at, scheduled_at, 0), id;
-- select * from scoped_leagues order by id;
-- select * from scoped_teams   order by league_id, name;
-- select * from scoped_players order by league_id, name;
-- select * from scoped_events  order by game_id, ts, id;
-- select * from scoped_roster_receipts order by created_at;
-- select * from scoped_rec_receipts    order by game_id;
--
-- Everything at once, one row per record, if you would rather scan it in a
-- single result set than run seven queries:
--
-- select 'leagues' as src, to_jsonb(t) as record from scoped_leagues t
-- union all select 'teams',    to_jsonb(t) from scoped_teams t
-- union all select 'players',  to_jsonb(t) from scoped_players t
-- union all select 'games',    to_jsonb(t) from scoped_games t
-- union all select 'events',   to_jsonb(t) from scoped_events t
-- union all select 'roster_import_receipts', to_jsonb(t) from scoped_roster_receipts t
-- union all select 'rec_setup_receipts',     to_jsonb(t) from scoped_rec_receipts t;


-- =============================================================================
-- PART 3 - RESTORE PREFLIGHT: auth.users DEPENDENCIES
-- =============================================================================
-- Three columns in the backup are foreign keys into auth.users. If one of those
-- accounts is deleted between the backup and the restore, that INSERT fails and
-- rolls the entire restore back.
--
-- Run this now to record which accounts the backup depends on, and again just
-- before restoring. Any row with user_exists = false will break the restore.
--
-- If an account really is gone and you still need the data:
--   games.created_by     -> safe to null out. The column is `on delete set null`
--                           in the schema, so null is a state it is already
--                           designed for.
--   *_receipts.actor_id  -> NOT safe to null (the column is not null) and not
--                           safe to repoint at another user. Drop those two
--                           receipt inserts instead, and note that you did: the
--                           cost is that a client replaying that exact import_id
--                           would re-run the import rather than recognising it
--                           as already done.

with
  params as (
    select now() - interval '24 hours' as since,
           now()                       as until
  ),
  win as (
    select since, until,
           (extract(epoch from since) * 1000)::bigint as since_ms,
           (extract(epoch from until) * 1000)::bigint as until_ms
      from params
  ),
  scoped_games as (
    select g.*
      from public.games g
     cross join win w
     where g.updated_at   between w.since    and w.until
        or g.finished_at  between w.since_ms and w.until_ms
        or g.scheduled_at between w.since_ms and w.until_ms
        or exists (select 1 from public.events e
                    where e.game_id = g.id
                      and e.created_at between w.since and w.until)
  ),
  base_leagues as (
    select l.* from public.leagues l
     where l.id in (select league_id from scoped_games)
  ),
  deps(source_column, user_id) as (
    select 'games.created_by', g.created_by
      from scoped_games g where g.created_by is not null
    union
    select 'roster_import_receipts.actor_id', r.actor_id
      from public.roster_import_receipts r cross join win w
     where r.league_id in (select id from base_leagues)
       and r.created_at between w.since and w.until
    union
    select 'rec_setup_receipts.actor_id', s.actor_id
      from public.rec_setup_receipts s
     where s.game_id in (select id from scoped_games)
  )
select d.source_column,
       d.user_id,
       exists (select 1 from auth.users u where u.id = d.user_id) as user_exists
  from deps d
 order by user_exists, source_column, user_id;


-- =============================================================================
-- PART 4 - THE GENERATOR
-- =============================================================================
-- Returns the restore script, one statement per row, already ordered so parents
-- are inserted before the rows that reference them:
--
--   leagues -> teams -> players -> games -> events -> receipts
--
-- To save it: run this, then use the SQL Editor's "Download CSV" on the result.
-- Then turn that download into a dated, runnable file with:
--
--   node supabase/ops/write-backup-file.js <downloaded.csv>
--
-- which unwraps the CSV quoting and writes backup-YYYY-MM-DD.sql. That script
-- also refuses to write a truncated result, which is the realistic failure here.
--
-- -----------------------------------------------------------------------------
-- WHY THE LITERALS ARE BUILT BY HAND INSTEAD OF WITH %L
-- -----------------------------------------------------------------------------
-- The obvious way to write this is format('%L', col). It is correct SQL, and it
-- was wrong here for one reason: quote_literal emits a RAW newline for a value
-- that contains one, so an events.note typed across two lines produces a
-- statement that spans two lines.
--
-- Every transport between this grid and a restored database then gets a say in
-- what that newline becomes. Windows text-mode output, a CSV round trip, git's
-- core.autocrlf, a copy-paste through an editor - any one of them can rewrite it
-- to CRLF, and the note comes back with a carriage return that was never in it.
-- That corruption is silent: the file still parses, the restore still commits.
-- It was caught by restoring into a second database and diffing every row.
--
-- So each value is escaped into an E'...' literal with the line breaks written
-- as \r and \n. Every generated statement is then exactly ONE line of pure
-- ASCII-safe punctuation, and no transport can change its meaning.
--
-- chr(92), chr(13), chr(10) rather than the backslash literals they stand for,
-- deliberately: a backslash in this file has to survive being pasted through a
-- browser textarea, a shell heredoc and an editor before Postgres parses it, and
-- at least one of those collapses a doubled backslash. chr() cannot be mangled.
--
-- Escape order matters and is load-bearing: backslashes FIRST, so the
-- backslashes introduced for \r and \n are not doubled a second time.
--
-- Casting every column to text and escaping uniformly means booleans, bigints,
-- uuids, timestamps, text[] and jsonb all take the same path. Postgres coerces
-- the quoted literal back to the column type on insert, exactly as %L relied on.

with
  params as (
    select now() - interval '24 hours' as since,
           now()                       as until,
           true                        as include_whole_league
  ),
  win as (
    select since, until, include_whole_league,
           (extract(epoch from since) * 1000)::bigint as since_ms,
           (extract(epoch from until) * 1000)::bigint as until_ms
      from params
  ),
  scoped_games as (
    select g.*
      from public.games g
     cross join win w
     where g.updated_at   between w.since    and w.until
        or g.finished_at  between w.since_ms and w.until_ms
        or g.scheduled_at between w.since_ms and w.until_ms
        or exists (select 1 from public.events e
                    where e.game_id = g.id
                      and e.created_at between w.since and w.until)
  ),
  base_leagues as (
    select l.* from public.leagues l
     where l.id in (select league_id from scoped_games)
  ),
  scoped_events as (
    select e.* from public.events e
     where e.game_id in (select id from scoped_games)
  ),
  scoped_teams as (
    select t.* from public.teams t cross join win w
     where (w.include_whole_league and t.league_id in (select id from base_leagues))
        or t.id in (select home_team_id from scoped_games)
        or t.id in (select away_team_id from scoped_games)
        or t.id in (select team_id from scoped_events)
  ),
  referenced_player_ids as (
    select u as id from scoped_teams t, unnest(t.player_ids) u
    union
    select u from scoped_games g,
      unnest(coalesce(g.attendance, '{}'::text[]) || g.home_on_court || g.away_on_court) u
    union
    select e.player_id from scoped_events e where e.player_id is not null
  ),
  scoped_players as (
    select p.* from public.players p cross join win w
     where (w.include_whole_league and p.league_id in (select id from base_leagues))
        or p.id in (select id from referenced_player_ids)
  ),
  scoped_roster_receipts as (
    select r.* from public.roster_import_receipts r cross join win w
     where r.league_id in (select id from base_leagues)
       and r.created_at between w.since and w.until
  ),
  scoped_rec_receipts as (
    select s.* from public.rec_setup_receipts s
     where s.game_id in (select id from scoped_games)
  ),
  -- THE LEAGUE CLOSURE, and the reason base_leagues above is kept separate.
  --
  -- teams.league_id, players.league_id, events.league_id and
  -- rec_setup_receipts.league_id are every one of them a foreign key to leagues.
  -- Teams and players are collected BY ID above, because games.home_team_id,
  -- games.away_team_id and events.team_id carry no foreign key at all - so a row
  -- the backup carries can belong to a league that had no game in the window.
  --
  -- Deriving the league list from the games alone left that league out, and the
  -- restore then died on teams_league_id_fkey and rolled back EVERY row: a
  -- backup file that restores nothing. So the list is closed over what is
  -- actually being written, not over what started the search.
  --
  -- Only the league ROW is added. Its roster is not expanded, even when
  -- include_whole_league is true - it is here to satisfy a foreign key, not
  -- because anything happened in it.
  scoped_leagues as (
    select l.* from public.leagues l
     where l.id in (select league_id from scoped_games)
        or l.id in (select league_id from scoped_teams)
        or l.id in (select league_id from scoped_players)
        or l.id in (select league_id from scoped_events)
        or l.id in (select league_id from scoped_rec_receipts)
        or l.id in (select league_id from scoped_roster_receipts)
  ),

  -- One row per record to back up, carrying its target table, its column list,
  -- its conflict key and its values already flattened to text. Keeping the
  -- column lists spelled out here (rather than reflecting over the catalog) is
  -- what PART 0's drift guard checks against.
  rows_to_dump(ord, tbl, cols, conflict_col, sub, vals) as (

    select 21, 'leagues',
           'id, name, season, kind, foul_out_limit, track_misses, track_turnovers, is_shared, is_closed, is_archived, created_at, updated_at',
           'id', row_number() over (order by l.id),
           array[l.id, l.name, l.season, l.kind, l.foul_out_limit::text,
                 l.track_misses::text, l.track_turnovers::text, l.is_shared::text,
                 l.is_closed::text, l.is_archived::text, l.created_at::text,
                 l.updated_at::text]
      from scoped_leagues l

    union all
    select 31, 'teams',
           'id, league_id, name, color, coach, logo, team_only, player_ids, updated_at',
           'id', row_number() over (order by t.league_id, t.id),
           array[t.id, t.league_id, t.name, t.color, t.coach, t.logo,
                 t.team_only::text, t.player_ids::text, t.updated_at::text]
      from scoped_teams t

    union all
    select 41, 'players',
           'id, league_id, name, number, origin_player_id, updated_at',
           'id', row_number() over (order by p.league_id, p.id),
           array[p.id, p.league_id, p.name, p.number, p.origin_player_id,
                 p.updated_at::text]
      from scoped_players p

    union all
    select 51, 'games',
           'id, league_id, home_team_id, away_team_id, status, scheduled_at, location, finished_at, home_on_court, away_on_court, period, attendance, track_misses, track_turnovers, created_by, updated_at',
           'id', row_number() over (order by coalesce(g.finished_at, g.scheduled_at, 0), g.id),
           array[g.id, g.league_id, g.home_team_id, g.away_team_id, g.status,
                 g.scheduled_at::text, g.location, g.finished_at::text,
                 g.home_on_court::text, g.away_on_court::text, g.period::text,
                 g.attendance::text, g.track_misses::text, g.track_turnovers::text,
                 g.created_by::text, g.updated_at::text]
      from scoped_games g

    -- Chronological by (game, ts) so the restored log reads in play order, and a
    -- restore inspected halfway through stops at a sensible point rather than
    -- mid-possession.
    union all
    select 61, 'events',
           'id, league_id, game_id, team_id, player_id, type, period, ts, note, created_at',
           'id', row_number() over (order by e.game_id, e.ts, e.id),
           array[e.id, e.league_id, e.game_id, e.team_id, e.player_id, e.type,
                 e.period::text, e.ts::text, e.note, e.created_at::text]
      from scoped_events e

    -- Idempotency records. Restoring them is what stops a client replaying the
    -- same import_id / game_id from re-running an import or a rec setup and
    -- duplicating the roster.
    union all
    select 74, 'roster_import_receipts',
           'import_id, league_id, actor_id, payload, team_count, player_count, created_at',
           'import_id', row_number() over (order by r.created_at, r.import_id),
           array[r.import_id, r.league_id, r.actor_id::text, r.payload::text,
                 r.team_count::text, r.player_count::text, r.created_at::text]
      from scoped_roster_receipts r

    union all
    select 82, 'rec_setup_receipts',
           'game_id, league_id, actor_id, payload',
           'game_id', row_number() over (order by s.game_id),
           array[s.game_id, s.league_id, s.actor_id::text, s.payload::text]
      from scoped_rec_receipts s
  ),

  -- The literal builder, written once and applied to every column of every
  -- table. See the note at the top of PART 4 for why it is hand-rolled.
  inserts(ord, sub, stmt) as (
    select r.ord, r.sub,
           format('insert into public.%s (%s) values (%s) on conflict (%s) do nothing;',
                  r.tbl, r.cols, a.vlist, r.conflict_col)
      from rows_to_dump r
      cross join lateral (
        select string_agg(
                 case
                   when u.v is null then 'NULL'
                   else 'E''' || replace(
                                   replace(
                                     replace(
                                       replace(u.v, chr(92), chr(92) || chr(92)),
                                     '''', ''''''),
                                   chr(13), chr(92) || 'r'),
                                 chr(10), chr(92) || 'n') || ''''
                 end,
                 ', ' order by u.ord) as vlist
          from unnest(r.vals) with ordinality u(v, ord)
      ) a
  ),

  script(ord, sub, stmt) as (

    -- ---- header -------------------------------------------------------------
              select 0, 0::bigint, '-- iTala game backup'
    union all select 1, 0::bigint, format('-- generated at: %s', now())
    union all select 2, 0::bigint, format('-- window:       %s  ->  %s', w.since, w.until) from win w
    union all select 3, 0::bigint, format('-- whole league: %s', w.include_whole_league) from win w
    union all select 4, 0::bigint,
              format('-- contents:     %s leagues, %s teams, %s players, %s games, %s events, %s + %s receipts',
                     (select count(*) from scoped_leagues),
                     (select count(*) from scoped_teams),
                     (select count(*) from scoped_players),
                     (select count(*) from scoped_games),
                     (select count(*) from scoped_events),
                     (select count(*) from scoped_roster_receipts),
                     (select count(*) from scoped_rec_receipts))
    union all select  5, 0::bigint, '--'
    union all select  6, 0::bigint, '-- Run as the `postgres` role in the Supabase SQL Editor. RLS write policies'
    union all select  7, 0::bigint, '-- block these inserts for any other role.'
    union all select  8, 0::bigint, '--'
    union all select  9, 0::bigint, '-- Every statement is `on conflict ... do nothing`: rows that already exist are'
    union all select 10, 0::bigint, '-- left untouched, nothing newer is overwritten, and a re-run is a no-op.'
    union all select 11, 0::bigint, '-- Wrapped in a transaction, so any failure rolls the whole restore back.'
    union all select 12, 0::bigint, '--'
    union all select 13, 0::bigint, '-- games.created_by and both *_receipts.actor_id are foreign keys into'
    union all select 14, 0::bigint, '-- auth.users. If one of those accounts has since been deleted, that insert'
    union all select 15, 0::bigint, '-- fails and rolls the whole restore back. Run PART 3 of'
    union all select 16, 0::bigint, '-- supabase/ops/backup-recent-games.sql first to check.'
    union all select 17, 0::bigint, ''
    union all select 18, 0::bigint, 'begin;'
    union all select 19, 0::bigint, ''

    -- ---- the data -----------------------------------------------------------
    union all select 20, 0::bigint, format('-- leagues (%s)', (select count(*) from scoped_leagues))
    union all select 30, 0::bigint, format('-- teams (%s)',   (select count(*) from scoped_teams))
    union all select 40, 0::bigint, format('-- players (%s)', (select count(*) from scoped_players))
    union all select 50, 0::bigint, format('-- games (%s)',   (select count(*) from scoped_games))
    union all select 60, 0::bigint, format('-- events (%s)',  (select count(*) from scoped_events))
    union all select 70, 0::bigint, format('-- roster_import_receipts (%s)', (select count(*) from scoped_roster_receipts))
    union all select 80, 0::bigint, format('-- rec_setup_receipts (%s)',     (select count(*) from scoped_rec_receipts))
    union all select ord, sub, stmt from inserts

    -- ---- footer -------------------------------------------------------------
    union all select 98, 0::bigint, 'commit;'
    union all select 99, 0::bigint, '-- end of backup'
  )
select stmt
  from script
 order by ord, sub;
