/*
# Revoke write privileges on view_team_ratings

The view inherited INSERT/UPDATE/DELETE grants from the creator.
Revoke them so anon/authenticated can only SELECT from the view,
matching the read-only cloud tier contract.
*/

revoke insert, update, delete on public.view_team_ratings from anon, authenticated;

notify pgrst, 'reload schema';