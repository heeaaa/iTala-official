-- iTala v2 :: 0005 :: realtime publication
--
-- v2 APPLIES realtime payloads rather than using them as a bare "something
-- changed" signal. v1 discarded the payload and re-downloaded five entire
-- tables, including every base64 logo, on every change, including its own
-- writes echoing back to itself.
--
-- The default replica identity (primary key) is enough: a DELETE payload
-- carries the id, which is all the client needs to remove the row locally.

do $$
declare t text;
begin
  foreach t in array array['leagues', 'teams', 'players', 'games', 'events'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;
