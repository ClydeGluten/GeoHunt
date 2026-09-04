-- Before the ACTIVE-only GPS guard existed, permission denial or repeated poor
-- accuracy could erase an explicit HIDER/SEEKER assignment in DRAFT/LOBBY.
-- Restore only assignments followed by that exact automatic demotion.
WITH latest_assignment AS (
  SELECT DISTINCT ON (event.target_participant_id)
    event.target_participant_id AS participant_id,
    event.id AS assignment_event_id,
    (event.payload->>'role')::player_role AS assigned_role
  FROM game_events AS event
  WHERE event.type = 'ROLE_ASSIGNED'
    AND event.target_participant_id IS NOT NULL
  ORDER BY event.target_participant_id, event.id DESC
)
UPDATE participants AS participant
SET role = assignment.assigned_role
FROM latest_assignment AS assignment, matches AS match
WHERE participant.id = assignment.participant_id
  AND participant.match_id = match.id
  AND participant.role = 'SPECTATOR'
  AND assignment.assigned_role IN ('HIDER', 'SEEKER')
  AND match.state IN ('DRAFT', 'LOBBY')
  AND EXISTS (
    SELECT 1
    FROM game_events AS forced
    WHERE forced.match_id = participant.match_id
      AND forced.actor_participant_id = participant.id
      AND forced.type = 'GPS_SPECTATOR_FORCED'
      AND forced.id > assignment.assignment_event_id
  );
