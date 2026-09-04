-- HOST remains the pre-selection/referee sentinel so clients from before the
-- owner/gameplay-role split retain host controls while a deployment rolls out.
-- The current client presents it as "Referee (spectator)" and can change it to
-- HIDER, SEEKER, or SPECTATOR without losing ownership.
UPDATE participants AS participant
SET role = 'HOST'
FROM matches AS match
WHERE participant.match_id = match.id
  AND participant.account_id = match.host_account_id
  AND participant.role = 'SPECTATOR'
  AND match.state IN ('DRAFT', 'LOBBY');
