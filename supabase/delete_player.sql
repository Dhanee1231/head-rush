-- Run once in the Supabase SQL editor (project head-rush) to enable the in-game "Delete my data" button.
create or replace function public.delete_player(p_id uuid, p_secret text)
returns boolean
language plpgsql
security definer
set search_path to ''
as $$
declare v_existing text;
begin
  if p_id is null or p_secret is null or char_length(p_secret) < 16 or char_length(p_secret) > 128 then raise exception 'invalid player'; end if;
  select secret_hash into v_existing from public.players where id = p_id;
  if v_existing is null then return false; end if;
  if v_existing <> encode(extensions.digest(p_secret, 'sha256'), 'hex') then raise exception 'not your player'; end if;
  delete from public.players where id = p_id;  -- round history goes with it (on delete cascade)
  return true;
end;
$$;
revoke all on function public.delete_player(uuid, text) from public;
grant execute on function public.delete_player(uuid, text) to anon, authenticated;
