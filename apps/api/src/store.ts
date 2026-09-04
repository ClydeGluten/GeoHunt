import type {
  CreateMatchInput,
  LocationUpdate,
  MatchAction,
  MatchSettings,
  MatchState,
  PlayzonePolygon,
  PlayerRole,
  Position,
  ReplayFrame,
  UpdateMatchInput,
  VisibilityRule,
} from "@geohunter/contracts";
import { MatchSettingsSchema, PolygonSchema, VisibilityRuleSchema } from "@geohunter/contracts";
import type { DatabaseConnection } from "@geohunter/db";
import { assertTransition } from "@geohunter/game-engine";
import { hashToken, newOpaqueToken, type TelegramUserData } from "./security.js";

export interface SessionContext {
  id: string;
  kind: "TELEGRAM" | "GUEST";
  accountId: string | null;
  participantId: string | null;
  expiresAt: Date;
}

export interface ViewerContext {
  participantId: string;
  accountId: string | null;
  role: PlayerRole;
  displayName: string;
  isHost: boolean;
}

export function viewerVisibilityRole(viewer: ViewerContext): PlayerRole {
  return viewer.isHost && (viewer.role === "SPECTATOR" || viewer.role === "HOST") ? "HOST" : viewer.role;
}

export interface MatchRecord {
  id: string;
  hostAccountId: string;
  telegramChatId: string | null;
  name: string;
  state: MatchState;
  stateBeforePause: MatchState | null;
  winnerRole: "HIDER" | "SEEKER" | null;
  phaseStartedAt: Date | null;
  phaseEndsAt: Date | null;
  activeStartedAt: Date | null;
  pausedAt: Date | null;
  pausedDurationMs: number;
  emergencyReveal: boolean;
}

export interface RuntimeParticipant {
  id: string;
  accountId: string | null;
  displayName: string;
  role: PlayerRole;
  status: "ACTIVE" | "TAGGED" | "DISQUALIFIED" | "LEFT";
}

export interface RuntimeLocation extends Position {
  participantId: string;
  role: PlayerRole;
  displayName: string;
  clientSequence: number;
}

export interface MatchRuntime {
  match: MatchRecord;
  settings: MatchSettings;
  rules: VisibilityRule[];
  playzone: PlayzonePolygon;
  participants: RuntimeParticipant[];
  locations: RuntimeLocation[];
}

interface BoundaryResult {
  outside: boolean;
  graceEndsAt: Date | null;
  actionApplied: boolean;
  disqualified: boolean;
}

function settingsFromRow(row: Record<string, unknown>): MatchSettings {
  return MatchSettingsSchema.parse({
    durationSeconds: row.durationSeconds,
    hideSeconds: row.hideSeconds,
    tapTagEnabled: row.tapTagEnabled,
    autoTagEnabled: row.autoTagEnabled,
    tagRadiusMeters: row.tagRadiusMeters,
    autoTagDwellSeconds: row.autoTagDwellSeconds,
    tagCooldownSeconds: row.tagCooldownSeconds,
    positionMaxAgeSeconds: row.positionMaxAgeSeconds,
    maxAccuracyMeters: row.maxAccuracyMeters,
    maxSpeedMps: row.maxSpeedMps,
    caughtBehavior: row.caughtBehavior,
    boundaryGraceSeconds: row.boundaryGraceSeconds,
    boundaryAudience: row.boundaryAudience,
    boundaryDisqualify: row.boundaryDisqualify,
  });
}

function jsonPayload(value: unknown): string {
  const payload = JSON.stringify(value);
  if (payload === undefined) throw new Error("Game event payload is not JSON serializable");
  return payload;
}

export class GameStore {
  constructor(private readonly connection: DatabaseConnection) {}

  async ping(): Promise<void> {
    await this.connection.sql`select 1`;
  }

  async getAccount(accountId: string) {
    const [account] = await this.connection.sql`
      select id, telegram_user_id::text as "telegramUserId", username,
        trim(concat(first_name, ' ', coalesce(last_name, ''))) as "displayName", photo_url as "photoUrl"
      from accounts where id=${accountId}
    `;
    return account ?? null;
  }

  async upsertTelegramAccount(user: TelegramUserData): Promise<{ id: string; displayName: string }> {
    const [account] = await this.connection.sql<{ id: string; displayName: string }[]>`
      insert into accounts (telegram_user_id, username, first_name, last_name, photo_url)
      values (${String(user.id)}, ${user.username ?? null}, ${user.first_name}, ${user.last_name ?? null}, ${user.photo_url ?? null})
      on conflict (telegram_user_id) do update set
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        photo_url = excluded.photo_url,
        updated_at = now()
      returning id, trim(concat(first_name, ' ', coalesce(last_name, ''))) as "displayName"
    `;
    if (!account) throw new Error("Account upsert failed");
    return account;
  }

  async createDevAccount(displayName: string): Promise<{ id: string; displayName: string }> {
    const syntheticId = -(Date.now() * 1000 + Math.floor(Math.random() * 1000));
    return this.upsertTelegramAccount({ id: syntheticId, first_name: displayName });
  }

  async createSession(input: { kind: "TELEGRAM" | "GUEST"; accountId?: string; participantId?: string; days: number }) {
    const token = newOpaqueToken();
    const expiresAt = new Date(Date.now() + input.days * 86_400_000);
    await this.connection.sql`
      insert into auth_sessions (token_hash, kind, account_id, participant_id, expires_at)
      values (${hashToken(token)}, ${input.kind}, ${input.accountId ?? null}, ${input.participantId ?? null}, ${expiresAt.toISOString()})
    `;
    return { token, expiresAt };
  }

  async getSession(token: string): Promise<SessionContext | null> {
    const [session] = await this.connection.sql<SessionContext[]>`
      update auth_sessions set last_seen_at = now()
      where token_hash = ${hashToken(token)} and expires_at > now()
      returning id, kind, account_id as "accountId", participant_id as "participantId", expires_at as "expiresAt"
    `;
    return session ?? null;
  }

  async revokeSession(token: string): Promise<void> {
    await this.connection.sql`delete from auth_sessions where token_hash = ${hashToken(token)}`;
  }

  async findInvite(code: string): Promise<{ matchId: string; state: MatchState } | null> {
    const [invite] = await this.connection.sql<{ matchId: string; state: MatchState }[]>`
      select i.match_id as "matchId", m.state
      from invitations i join matches m on m.id = i.match_id
      where i.code_hash = ${hashToken(code)}
        and i.revoked_at is null
        and (i.expires_at is null or i.expires_at > now())
    `;
    return invite ?? null;
  }

  async getInvitePreview(code: string): Promise<{ matchId: string; name: string; state: MatchState; participantCount: number } | null> {
    const [preview] = await this.connection.sql<{ matchId: string; name: string; state: MatchState; participantCount: number }[]>`
      select m.id as "matchId", m.name, m.state, count(p.id)::integer as "participantCount"
      from invitations i join matches m on m.id=i.match_id left join participants p on p.match_id=m.id
      where i.code_hash=${hashToken(code)} and i.revoked_at is null and (i.expires_at is null or i.expires_at>now())
      group by m.id
    `;
    return preview ?? null;
  }

  async joinGuest(code: string, displayName: string): Promise<{ participantId: string; matchId: string }> {
    const invite = await this.findInvite(code);
    if (!invite || !["DRAFT", "LOBBY"].includes(invite.state)) throw new Error("Invite is invalid or match already started");
    const [participant] = await this.connection.sql<{ participantId: string }[]>`
      insert into participants (match_id, display_name, role, consent_location_at, consent_replay_at)
      values (${invite.matchId}, ${displayName}, 'SPECTATOR', now(), now())
      returning id as "participantId"
    `;
    if (!participant) throw new Error("Guest join failed");
    return { participantId: participant.participantId, matchId: invite.matchId };
  }

  async joinTelegram(code: string, accountId: string): Promise<{ participantId: string; matchId: string }> {
    const invite = await this.findInvite(code);
    if (!invite || !["DRAFT", "LOBBY"].includes(invite.state)) throw new Error("Invite is invalid or match already started");
    const [account] = await this.connection.sql<{ displayName: string }[]>`
      select trim(concat(first_name, ' ', coalesce(last_name, ''))) as "displayName" from accounts where id = ${accountId}
    `;
    if (!account) throw new Error("Account missing");
    const [participant] = await this.connection.sql<{ participantId: string }[]>`
      insert into participants (match_id, account_id, display_name, role, consent_location_at, consent_replay_at)
      values (${invite.matchId}, ${accountId}, ${account.displayName}, 'SPECTATOR', now(), now())
      on conflict (match_id, account_id) do update set left_at = null, status = 'ACTIVE'
      returning id as "participantId"
    `;
    if (!participant) throw new Error("Telegram join failed");
    return { participantId: participant.participantId, matchId: invite.matchId };
  }

  async createMatch(accountId: string, input: CreateMatchInput): Promise<{ matchId: string; inviteCode: string; participantId: string }> {
    const inviteCode = newOpaqueToken(18);
    return this.connection.sql.begin(async (transaction) => {
      const [match] = await transaction<{ id: string }[]>`
        insert into matches (host_account_id, telegram_chat_id, name)
        values (${accountId}, ${input.telegramChatId ?? null}, ${input.name})
        returning id
      `;
      if (!match) throw new Error("Match creation failed");
      if (input.telegramChatId) {
        await transaction`
          insert into telegram_chat_ownerships (telegram_chat_id, account_id) values (${input.telegramChatId}, ${accountId})
          on conflict (telegram_chat_id, account_id) do update set verified_at=now()
        `;
      }
      const settings = input.settings;
      await transaction`
        insert into match_settings (
          match_id, duration_seconds, hide_seconds, tap_tag_enabled, auto_tag_enabled, tag_radius_meters,
          auto_tag_dwell_seconds, tag_cooldown_seconds, position_max_age_seconds, max_accuracy_meters,
          max_speed_mps, caught_behavior, boundary_grace_seconds, boundary_audience, boundary_disqualify
        ) values (
          ${match.id}, ${settings.durationSeconds}, ${settings.hideSeconds}, ${settings.tapTagEnabled}, ${settings.autoTagEnabled},
          ${settings.tagRadiusMeters}, ${settings.autoTagDwellSeconds}, ${settings.tagCooldownSeconds}, ${settings.positionMaxAgeSeconds},
          ${settings.maxAccuracyMeters}, ${settings.maxSpeedMps}, ${settings.caughtBehavior}, ${settings.boundaryGraceSeconds},
          ${settings.boundaryAudience}, ${settings.boundaryDisqualify}
        )
      `;
      await transaction`
        insert into playzones (match_id, polygon)
        values (${match.id}, ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(input.playzone)}), 4326))
      `;
      for (const rule of input.visibilityRules) {
        await transaction`
          insert into visibility_rules (
            match_id, observer_role, target_role, mode, visible_duration_seconds,
            cycle_period_seconds, phase_offset_seconds, persist_last_seen
          ) values (
            ${match.id}, ${rule.observerRole}, ${rule.targetRole}, ${rule.mode}, ${rule.visibleDurationSeconds},
            ${rule.cyclePeriodSeconds}, ${rule.phaseOffsetSeconds}, ${rule.persistLastSeen}
          )
        `;
      }
      const [account] = await transaction<{ displayName: string }[]>`
        select trim(concat(first_name, ' ', coalesce(last_name, ''))) as "displayName" from accounts where id = ${accountId}
      `;
      const [participant] = await transaction<{ id: string }[]>`
        insert into participants (match_id, account_id, display_name, role, consent_location_at, consent_replay_at)
        values (${match.id}, ${accountId}, ${account?.displayName ?? "Host"}, 'HOST', now(), now())
        returning id
      `;
      if (!participant) throw new Error("Host participant creation failed");
      await transaction`insert into invitations (match_id, code_hash) values (${match.id}, ${hashToken(inviteCode)})`;
      await transaction`insert into game_events (match_id, type, actor_participant_id) values (${match.id}, 'MATCH_CREATED', ${participant.id})`;
      return { matchId: match.id, inviteCode, participantId: participant.id };
    });
  }

  async listMatches(accountId: string) {
    return this.connection.sql`
      select m.id, m.name, m.state, m.created_at as "createdAt", m.phase_ends_at as "phaseEndsAt",
        count(p.id)::integer as "participantCount"
      from matches m left join participants p on p.match_id = m.id
      where m.host_account_id = ${accountId}
      group by m.id order by m.created_at desc
    `;
  }

  async listMatchesByTelegramId(telegramUserId: string) {
    return this.connection.sql`
      select m.id, m.name, m.state, m.created_at as "createdAt", count(p.id)::integer as "participantCount"
      from accounts a join matches m on m.host_account_id=a.id left join participants p on p.match_id=m.id
      where a.telegram_user_id=${telegramUserId} group by m.id order by m.created_at desc limit 20
    `;
  }

  async getAccountIdByTelegramId(telegramUserId: string): Promise<string | null> {
    const [account] = await this.connection.sql<{ id: string }[]>`
      select id from accounts where telegram_user_id=${telegramUserId}
    `;
    return account?.id ?? null;
  }

  async performTelegramHostAction(telegramUserId: string, matchId: string, action: MatchAction): Promise<MatchState> {
    const accountId = await this.getAccountIdByTelegramId(telegramUserId);
    if (!accountId) throw new Error("Open the Mini App once to link your Telegram account");
    await this.assertHost(matchId, accountId);
    const [host] = await this.connection.sql<{ participantId: string }[]>`
      select id as "participantId" from participants where match_id=${matchId} and account_id=${accountId} and status <> 'LEFT'
    `;
    if (!host) throw new Error("Host participant missing");
    return this.performAction(matchId, host.participantId, action);
  }

  async rotateTelegramHostInvite(telegramUserId: string, matchId: string): Promise<string> {
    const accountId = await this.getAccountIdByTelegramId(telegramUserId);
    if (!accountId) throw new Error("Open the Mini App once to link your Telegram account");
    await this.assertHost(matchId, accountId);
    return this.rotateInvite(matchId);
  }

  async rotateInvite(matchId: string): Promise<string> {
    const code = newOpaqueToken(18);
    await this.connection.sql.begin(async (transaction) => {
      await transaction`update invitations set revoked_at=now() where match_id=${matchId} and revoked_at is null`;
      await transaction`insert into invitations (match_id, code_hash) values (${matchId}, ${hashToken(code)})`;
      await transaction`insert into game_events (match_id, type) values (${matchId}, 'INVITE_ROTATED')`;
    });
    return code;
  }

  async getViewer(matchId: string, session: SessionContext): Promise<ViewerContext | null> {
    const [viewer] = session.participantId
      ? await this.connection.sql<ViewerContext[]>`
          select p.id as "participantId", p.account_id as "accountId", p.role, p.display_name as "displayName",
            coalesce(m.host_account_id = p.account_id, false) as "isHost"
          from participants p join matches m on m.id = p.match_id
          where p.id = ${session.participantId} and p.match_id = ${matchId} and p.status <> 'LEFT'
        `
      : await this.connection.sql<ViewerContext[]>`
          select p.id as "participantId", p.account_id as "accountId", p.role, p.display_name as "displayName",
            coalesce(m.host_account_id = p.account_id, false) as "isHost"
          from participants p join matches m on m.id = p.match_id
          where p.account_id = ${session.accountId} and p.match_id = ${matchId} and p.status <> 'LEFT'
        `;
    return viewer ?? null;
  }

  async assertHost(matchId: string, accountId: string | null): Promise<void> {
    if (!accountId) throw new Error("Telegram host authentication required");
    const [match] = await this.connection.sql`select id from matches where id = ${matchId} and host_account_id = ${accountId}`;
    if (!match) throw new Error("Host access required");
  }

  async getRuntime(matchId: string): Promise<MatchRuntime | null> {
    const [row] = await this.connection.sql<Record<string, unknown>[]>`
      select m.id, m.host_account_id as "hostAccountId", m.telegram_chat_id::text as "telegramChatId", m.name,
        m.state, m.state_before_pause as "stateBeforePause", m.winner_role as "winnerRole",
        m.phase_started_at as "phaseStartedAt", m.phase_ends_at as "phaseEndsAt",
        m.active_started_at as "activeStartedAt", m.paused_at as "pausedAt",
        m.paused_duration_ms::double precision as "pausedDurationMs", m.emergency_reveal as "emergencyReveal",
        s.duration_seconds as "durationSeconds", s.hide_seconds as "hideSeconds",
        s.tap_tag_enabled as "tapTagEnabled", s.auto_tag_enabled as "autoTagEnabled",
        s.tag_radius_meters as "tagRadiusMeters", s.auto_tag_dwell_seconds as "autoTagDwellSeconds",
        s.tag_cooldown_seconds as "tagCooldownSeconds", s.position_max_age_seconds as "positionMaxAgeSeconds",
        s.max_accuracy_meters as "maxAccuracyMeters", s.max_speed_mps as "maxSpeedMps",
        s.caught_behavior as "caughtBehavior", s.boundary_grace_seconds as "boundaryGraceSeconds",
        s.boundary_audience as "boundaryAudience", s.boundary_disqualify as "boundaryDisqualify",
        ST_AsGeoJSON(z.polygon)::json as playzone
      from matches m join match_settings s on s.match_id = m.id join playzones z on z.match_id = m.id
      where m.id = ${matchId}
    `;
    if (!row) return null;
    const rulesRaw = await this.connection.sql<Record<string, unknown>[]>`
      select observer_role as "observerRole", target_role as "targetRole", mode,
        visible_duration_seconds as "visibleDurationSeconds", cycle_period_seconds as "cyclePeriodSeconds",
        phase_offset_seconds as "phaseOffsetSeconds", persist_last_seen as "persistLastSeen"
      from visibility_rules where match_id = ${matchId}
    `;
    const participantsRows = await this.connection.sql<RuntimeParticipant[]>`
      select id, account_id as "accountId", display_name as "displayName", role, status
      from participants where match_id = ${matchId} and status <> 'LEFT' order by joined_at
    `;
    const locationRows = await this.connection.sql<RuntimeLocation[]>`
      select l.participant_id as "participantId", p.role, p.display_name as "displayName",
        ST_Y(l.point::geometry) as latitude, ST_X(l.point::geometry) as longitude,
        l.accuracy_meters as "accuracyMeters", l.speed_mps as "speedMps", l.heading_degrees as "headingDegrees",
        l.recorded_at::text as "recordedAt", l.client_sequence::double precision as "clientSequence"
      from latest_locations l join participants p on p.id = l.participant_id
      where l.match_id = ${matchId} and p.status <> 'LEFT'
    `;
    return {
      match: {
        id: String(row.id), hostAccountId: String(row.hostAccountId), telegramChatId: row.telegramChatId as string | null,
        name: String(row.name), state: row.state as MatchState, stateBeforePause: row.stateBeforePause as MatchState | null,
        winnerRole: row.winnerRole as "HIDER" | "SEEKER" | null, phaseStartedAt: row.phaseStartedAt as Date | null,
        phaseEndsAt: row.phaseEndsAt as Date | null, activeStartedAt: row.activeStartedAt as Date | null,
        pausedAt: row.pausedAt as Date | null, pausedDurationMs: Number(row.pausedDurationMs), emergencyReveal: Boolean(row.emergencyReveal),
      },
      settings: settingsFromRow(row),
      rules: rulesRaw.map((rule) => VisibilityRuleSchema.parse(rule)),
      playzone: PolygonSchema.parse(row.playzone),
      participants: participantsRows,
      locations: locationRows,
    };
  }

  async updateMatch(matchId: string, input: UpdateMatchInput): Promise<void> {
    await this.connection.sql.begin(async (transaction) => {
      const [match] = await transaction<{ state: MatchState }[]>`select state from matches where id = ${matchId} for update`;
      if (!match || !["DRAFT", "LOBBY"].includes(match.state)) throw new Error("Only draft or lobby matches can be edited");
      if (input.name) await transaction`update matches set name = ${input.name} where id = ${matchId}`;
      if (input.playzone) {
        await transaction`
          update playzones set polygon = ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(input.playzone)}), 4326), updated_at = now()
          where match_id = ${matchId}
        `;
      }
      if (input.settings) {
        const settings = input.settings;
        await transaction`
          update match_settings set duration_seconds=${settings.durationSeconds}, hide_seconds=${settings.hideSeconds},
            tap_tag_enabled=${settings.tapTagEnabled}, auto_tag_enabled=${settings.autoTagEnabled}, tag_radius_meters=${settings.tagRadiusMeters},
            auto_tag_dwell_seconds=${settings.autoTagDwellSeconds}, tag_cooldown_seconds=${settings.tagCooldownSeconds},
            position_max_age_seconds=${settings.positionMaxAgeSeconds}, max_accuracy_meters=${settings.maxAccuracyMeters},
            max_speed_mps=${settings.maxSpeedMps}, caught_behavior=${settings.caughtBehavior},
            boundary_grace_seconds=${settings.boundaryGraceSeconds}, boundary_audience=${settings.boundaryAudience},
            boundary_disqualify=${settings.boundaryDisqualify} where match_id=${matchId}
        `;
      }
      if (input.visibilityRules) {
        await transaction`delete from visibility_rules where match_id = ${matchId}`;
        for (const rule of input.visibilityRules) {
          await transaction`
            insert into visibility_rules (match_id, observer_role, target_role, mode, visible_duration_seconds, cycle_period_seconds, phase_offset_seconds, persist_last_seen)
            values (${matchId}, ${rule.observerRole}, ${rule.targetRole}, ${rule.mode}, ${rule.visibleDurationSeconds}, ${rule.cyclePeriodSeconds}, ${rule.phaseOffsetSeconds}, ${rule.persistLastSeen})
          `;
        }
      }
      await transaction`insert into game_events (match_id, type, payload) values (${matchId}, 'MATCH_UPDATED', ${jsonPayload(input)})`;
    });
  }

  async assignRole(matchId: string, participantId: string, role: Exclude<PlayerRole, "HOST">): Promise<void> {
    const result = await this.connection.sql`
      update participants p set role = ${role}, status = 'ACTIVE'
      from matches m where p.id = ${participantId} and p.match_id = ${matchId} and m.id = p.match_id
        and m.state in ('DRAFT', 'LOBBY')
      returning p.id
    `;
    if (result.count !== 1) throw new Error("Role cannot be assigned");
    await this.connection.sql`insert into game_events (match_id, type, target_participant_id, payload) values (${matchId}, 'ROLE_ASSIGNED', ${participantId}, ${jsonPayload({ role })})`;
  }

  async autoBalance(matchId: string): Promise<void> {
    await this.connection.sql.begin(async (transaction) => {
      const [match] = await transaction<{ state: MatchState }[]>`select state from matches where id=${matchId} for update`;
      if (!match || !["DRAFT", "LOBBY"].includes(match.state)) throw new Error("Roles can only be balanced before the match starts");
      const players = await transaction<{ id: string }[]>`
        select p.id from participants p join matches m on m.id=p.match_id
        where p.match_id=${matchId} and p.status='ACTIVE' and p.account_id is distinct from m.host_account_id
        order by p.joined_at, p.id
      `;
      if (players.length < 2) throw new Error("At least two players are required to balance roles");
      const seekerCount = Math.max(1, Math.round(players.length / 4));
      for (const [index, player] of players.entries()) {
        await transaction`update participants set role=${index < seekerCount ? "SEEKER" : "HIDER"} where id=${player.id}`;
      }
      await transaction`insert into game_events (match_id, type, payload) values (${matchId}, 'ROLES_AUTO_BALANCED', ${jsonPayload({ seekerCount, hiderCount: players.length - seekerCount })})`;
    });
  }

  async moderateParticipant(matchId: string, participantId: string, action: "SPECTATE" | "DISQUALIFY" | "REMOVE"): Promise<void> {
    const result = action === "REMOVE"
      ? await this.connection.sql`update participants p set status='LEFT', left_at=now() from matches m where p.id=${participantId} and p.match_id=${matchId} and p.account_id is distinct from m.host_account_id and m.id=p.match_id and m.state not in ('FINISHED','CANCELED') returning p.id`
      : action === "DISQUALIFY"
        ? await this.connection.sql`update participants p set status='DISQUALIFIED', role='SPECTATOR' from matches m where p.id=${participantId} and p.match_id=${matchId} and p.account_id is distinct from m.host_account_id and m.id=p.match_id and m.state not in ('FINISHED','CANCELED') returning p.id`
        : await this.connection.sql`update participants p set status='ACTIVE', role='SPECTATOR' from matches m where p.id=${participantId} and p.match_id=${matchId} and p.account_id is distinct from m.host_account_id and m.id=p.match_id and m.state not in ('FINISHED','CANCELED') returning p.id`;
    if (result.count !== 1) throw new Error("Participant cannot be moderated");
    await this.connection.sql`insert into game_events (match_id, type, target_participant_id, payload) values (${matchId}, 'PARTICIPANT_MODERATED', ${participantId}, ${jsonPayload({ action })})`;
  }

  async performAction(matchId: string, actorParticipantId: string, action: MatchAction): Promise<MatchState> {
    return this.connection.sql.begin(async (transaction) => {
      const [match] = await transaction<{ state: MatchState; stateBeforePause: MatchState | null; pausedAt: Date | null }[]>`
        select state, state_before_pause as "stateBeforePause", paused_at as "pausedAt" from matches where id = ${matchId} for update
      `;
      if (!match) throw new Error("Match not found");
      let nextState = match.state;
      const now = new Date();
      const nowIso = now.toISOString();
      if (action === "OPEN_LOBBY") {
        assertTransition(match.state, "LOBBY");
        nextState = "LOBBY";
        await transaction`update matches set state='LOBBY', phase_started_at=${nowIso} where id=${matchId}`;
      } else if (action === "START") {
        const [counts] = await transaction<{ hiders: number; seekers: number; hideSeconds: number; durationSeconds: number }[]>`
          select count(*) filter (where p.role='HIDER' and p.status='ACTIVE')::integer as hiders,
            count(*) filter (where p.role='SEEKER' and p.status='ACTIVE')::integer as seekers,
            s.hide_seconds as "hideSeconds", s.duration_seconds as "durationSeconds"
          from participants p cross join match_settings s where p.match_id=${matchId} and s.match_id=${matchId}
          group by s.hide_seconds, s.duration_seconds
        `;
        if (!counts || counts.hiders < 1 || counts.seekers < 1) throw new Error("Match needs at least one hider and one seeker");
        nextState = counts.hideSeconds > 0 ? "HIDING" : "ACTIVE";
        assertTransition(match.state, nextState);
        const phaseEndsAt = new Date(now.getTime() + (counts.hideSeconds > 0 ? counts.hideSeconds : counts.durationSeconds) * 1000);
        await transaction`
          update matches set state=${nextState}, phase_started_at=${nowIso}, phase_ends_at=${phaseEndsAt.toISOString()},
            active_started_at=${nextState === "ACTIVE" ? nowIso : null}, paused_at=null, paused_duration_ms=0 where id=${matchId}
        `;
      } else if (action === "PAUSE") {
        assertTransition(match.state, "PAUSED");
        nextState = "PAUSED";
        await transaction`update matches set state='PAUSED', state_before_pause=${match.state}, paused_at=${nowIso} where id=${matchId}`;
      } else if (action === "RESUME") {
        if (match.state !== "PAUSED" || !match.stateBeforePause || !match.pausedAt) throw new Error("Match is not paused");
        nextState = match.stateBeforePause;
        const pauseMs = now.getTime() - match.pausedAt.getTime();
        await transaction`
          update matches set state=${nextState}, state_before_pause=null, paused_at=null,
            paused_duration_ms=paused_duration_ms+${pauseMs}, phase_ends_at=phase_ends_at+(${pauseMs} * interval '1 millisecond')
          where id=${matchId}
        `;
      } else if (action === "END") {
        if (["FINISHED", "CANCELED"].includes(match.state)) throw new Error("Match already closed");
        nextState = "FINISHED";
        await transaction`update matches set state='FINISHED', phase_ends_at=${nowIso}, finished_at=${nowIso}, emergency_reveal=false where id=${matchId}`;
      } else if (action === "CANCEL") {
        if (["FINISHED", "CANCELED"].includes(match.state)) throw new Error("Match already closed");
        nextState = "CANCELED";
        await transaction`update matches set state='CANCELED', phase_ends_at=${nowIso}, finished_at=${nowIso}, emergency_reveal=false where id=${matchId}`;
      } else if (action === "EMERGENCY_REVEAL_ON" || action === "EMERGENCY_REVEAL_OFF") {
        if (["FINISHED", "CANCELED"].includes(match.state)) throw new Error("Match already closed");
        await transaction`update matches set emergency_reveal=${action === "EMERGENCY_REVEAL_ON"} where id=${matchId}`;
      }
      await transaction`
        insert into game_events (match_id, type, actor_participant_id, payload)
        values (${matchId}, ${action}, ${actorParticipantId}, ${jsonPayload({ previousState: match.state, nextState })})
      `;
      return nextState;
    });
  }

  async advanceTimers(): Promise<Array<{ matchId: string; state: MatchState }>> {
    const activated = await this.connection.sql<{ matchId: string; state: MatchState }[]>`
      update matches m set state='ACTIVE', phase_started_at=now(), active_started_at=now(), paused_duration_ms=0,
        phase_ends_at=now()+(s.duration_seconds * interval '1 second')
      from match_settings s where m.id=s.match_id and m.state='HIDING' and m.phase_ends_at<=now()
      returning m.id as "matchId", m.state
    `;
    for (const item of activated) await this.connection.sql`insert into game_events (match_id, type) values (${item.matchId}, 'HIDING_ENDED')`;
    const finished = await this.connection.sql<{ matchId: string; state: MatchState }[]>`
      update matches set state='FINISHED', winner_role='HIDER', finished_at=now(), emergency_reveal=false
      where state='ACTIVE' and phase_ends_at<=now()
      returning id as "matchId", state
    `;
    for (const item of finished) await this.connection.sql`insert into game_events (match_id, type, payload) values (${item.matchId}, 'MATCH_FINISHED', '{"winnerRole":"HIDER"}'::jsonb)`;
    return [...activated, ...finished];
  }

  async getPreviousPosition(participantId: string): Promise<Position | null> {
    const [position] = await this.connection.sql<Position[]>`
      select ST_Y(point::geometry) as latitude, ST_X(point::geometry) as longitude,
        accuracy_meters as "accuracyMeters", speed_mps as "speedMps", heading_degrees as "headingDegrees",
        recorded_at::text as "recordedAt" from latest_locations where participant_id=${participantId}
    `;
    return position ?? null;
  }

  async saveLocation(participantId: string, update: LocationUpdate): Promise<BoundaryResult> {
    return this.connection.sql.begin(async (transaction) => {
      const point = transaction`ST_SetSRID(ST_MakePoint(${update.longitude}, ${update.latitude}), 4326)::geography`;
      await transaction`
        insert into location_samples (match_id, participant_id, point, recorded_at, accuracy_meters, speed_mps, heading_degrees, source, client_sequence)
        values (${update.matchId}, ${participantId}, ${point}, ${update.recordedAt}, ${update.accuracyMeters}, ${update.speedMps}, ${update.headingDegrees}, ${update.source}, ${update.clientSequence})
      `;
      await transaction`
        insert into latest_locations (participant_id, match_id, point, recorded_at, accuracy_meters, speed_mps, heading_degrees, source, client_sequence)
        values (${participantId}, ${update.matchId}, ${point}, ${update.recordedAt}, ${update.accuracyMeters}, ${update.speedMps}, ${update.headingDegrees}, ${update.source}, ${update.clientSequence})
        on conflict (participant_id) do update set point=excluded.point, recorded_at=excluded.recorded_at,
          received_at=now(), accuracy_meters=excluded.accuracy_meters, speed_mps=excluded.speed_mps,
          heading_degrees=excluded.heading_degrees, source=excluded.source, client_sequence=excluded.client_sequence
        where latest_locations.client_sequence < excluded.client_sequence
      `;
      const [boundary] = await transaction<{ inside: boolean; graceSeconds: number; disqualify: boolean }[]>`
        select ST_Covers(z.polygon, ${point}::geometry) as inside, s.boundary_grace_seconds as "graceSeconds",
          s.boundary_disqualify as disqualify from playzones z join match_settings s on s.match_id=z.match_id where z.match_id=${update.matchId}
      `;
      if (!boundary) throw new Error("Playzone missing");
      const now = new Date();
      const nowIso = now.toISOString();
      if (boundary.inside) {
        const [existing] = await transaction`delete from boundary_states where participant_id=${participantId} returning participant_id`;
        if (existing) await transaction`insert into game_events (match_id, type, actor_participant_id, point) values (${update.matchId}, 'BOUNDARY_REENTERED', ${participantId}, ${point})`;
        return { outside: false, graceEndsAt: null, actionApplied: false, disqualified: false };
      }
      const [existing] = await transaction<{ graceEndsAt: Date; actionAppliedAt: Date | null }[]>`
        select grace_ends_at as "graceEndsAt", action_applied_at as "actionAppliedAt" from boundary_states where participant_id=${participantId} for update
      `;
      const graceEndsAt = existing?.graceEndsAt ?? new Date(now.getTime() + boundary.graceSeconds * 1000);
      if (!existing) {
        await transaction`insert into boundary_states (participant_id, match_id, outside_since, grace_ends_at) values (${participantId}, ${update.matchId}, ${nowIso}, ${graceEndsAt.toISOString()})`;
        await transaction`insert into game_events (match_id, type, actor_participant_id, point, payload) values (${update.matchId}, 'BOUNDARY_WARNING', ${participantId}, ${point}, ${jsonPayload({ graceEndsAt: graceEndsAt.toISOString() })})`;
      }
      const shouldApply = now >= graceEndsAt && !existing?.actionAppliedAt;
      if (shouldApply) {
        await transaction`update boundary_states set action_applied_at=${nowIso}, updated_at=${nowIso} where participant_id=${participantId}`;
        await transaction`insert into game_events (match_id, type, actor_participant_id, point) values (${update.matchId}, 'BOUNDARY_GRACE_EXPIRED', ${participantId}, ${point})`;
        if (boundary.disqualify) {
          await transaction`update participants set status='DISQUALIFIED', role='SPECTATOR' where id=${participantId}`;
        }
      }
      return { outside: true, graceEndsAt, actionApplied: shouldApply, disqualified: shouldApply && boundary.disqualify };
    });
  }

  async recordRejectedLocation(participantId: string, matchId: string, reason: string, update: LocationUpdate): Promise<void> {
    await this.connection.sql`
      insert into game_events (match_id, type, actor_participant_id, payload)
      values (${matchId}, 'LOCATION_REJECTED', ${participantId}, ${jsonPayload({ reason, sequence: update.clientSequence, accuracyMeters: update.accuracyMeters })})
    `;
  }

  async loadTagData(matchId: string, seekerId: string, targetId: string) {
    const rows = await this.connection.sql<Array<RuntimeLocation & { id: string }>>`
      select p.id, p.role, p.display_name as "displayName", l.client_sequence::double precision as "clientSequence",
        ST_Y(l.point::geometry) as latitude, ST_X(l.point::geometry) as longitude,
        l.accuracy_meters as "accuracyMeters", l.speed_mps as "speedMps", l.heading_degrees as "headingDegrees",
        l.recorded_at::text as "recordedAt"
      from participants p join latest_locations l on l.participant_id=p.id
      where p.match_id=${matchId} and p.id in (${seekerId}, ${targetId}) and p.status='ACTIVE'
    `;
    return { seeker: rows.find((row) => row.id === seekerId) ?? null, target: rows.find((row) => row.id === targetId) ?? null };
  }

  async activeHidersWithLocations(matchId: string): Promise<RuntimeLocation[]> {
    return this.connection.sql<RuntimeLocation[]>`
      select p.id as "participantId", p.role, p.display_name as "displayName", l.client_sequence::double precision as "clientSequence",
        ST_Y(l.point::geometry) as latitude, ST_X(l.point::geometry) as longitude,
        l.accuracy_meters as "accuracyMeters", l.speed_mps as "speedMps", l.heading_degrees as "headingDegrees",
        l.recorded_at::text as "recordedAt"
      from participants p join latest_locations l on l.participant_id=p.id
      where p.match_id=${matchId} and p.role='HIDER' and p.status='ACTIVE'
    `;
  }

  async isTagWithin(matchId: string, seekerId: string, targetId: string, radiusMeters: number): Promise<{ within: boolean; distanceMeters: number }> {
    const [result] = await this.connection.sql<{ within: boolean; distanceMeters: number }[]>`
      select ST_DWithin(seeker.point, target.point, ${radiusMeters}) as within,
        ST_Distance(seeker.point, target.point) as "distanceMeters"
      from latest_locations seeker join latest_locations target on target.participant_id=${targetId}
      where seeker.participant_id=${seekerId} and seeker.match_id=${matchId} and target.match_id=${matchId}
    `;
    return result ?? { within: false, distanceMeters: Number.POSITIVE_INFINITY };
  }

  async forceSpectator(matchId: string, participantId: string, reason: "DENIED" | "INACCURATE"): Promise<boolean> {
    const [changed] = await this.connection.sql`
      update participants p set role='SPECTATOR'
      from matches m
      where p.id=${participantId} and p.match_id=${matchId} and m.id=p.match_id
        and m.state='ACTIVE' and p.role not in ('HOST', 'SPECTATOR')
      returning p.id
    `;
    if (!changed) return false;
    await this.connection.sql`
      insert into game_events (match_id, type, actor_participant_id, payload)
      values (${matchId}, 'GPS_SPECTATOR_FORCED', ${participantId}, ${jsonPayload({ reason })})
    `;
    return true;
  }

  async applyTag(matchId: string, seekerId: string, targetId: string, caughtBehavior: "SEEKER" | "SPECTATOR", distanceMeters: number) {
    return this.connection.sql.begin(async (transaction) => {
      const [target] = await transaction<{ role: PlayerRole; status: string }[]>`
        select role, status from participants where id=${targetId} and match_id=${matchId} for update
      `;
      if (!target || target.role !== "HIDER" || target.status !== "ACTIVE") return { applied: false, finished: false };
      if (caughtBehavior === "SEEKER") {
        await transaction`update participants set role='SEEKER', status='ACTIVE', tagged_at=now() where id=${targetId}`;
      } else {
        await transaction`update participants set role='SPECTATOR', status='TAGGED', tagged_at=now() where id=${targetId}`;
      }
      await transaction`
        insert into game_events (match_id, type, actor_participant_id, target_participant_id, payload)
        values (${matchId}, 'PARTICIPANT_TAGGED', ${seekerId}, ${targetId}, ${jsonPayload({ caughtBehavior, distanceMeters })})
      `;
      const [remaining] = await transaction<{ count: number }[]>`
        select count(*)::integer as count from participants where match_id=${matchId} and role='HIDER' and status='ACTIVE'
      `;
      const finished = remaining?.count === 0;
      if (finished) {
        await transaction`update matches set state='FINISHED', winner_role='SEEKER', finished_at=now(), phase_ends_at=now(), emergency_reveal=false where id=${matchId} and state='ACTIVE'`;
        await transaction`insert into game_events (match_id, type, payload) values (${matchId}, 'MATCH_FINISHED', '{"winnerRole":"SEEKER"}'::jsonb)`;
      }
      return { applied: true, finished };
    });
  }

  async setReplayPublished(matchId: string, accountId: string, published: boolean): Promise<void> {
    if (published) {
      const [match] = await this.connection.sql`select id from matches where id=${matchId} and state='FINISHED'`;
      if (!match) throw new Error("Only a finished match replay can be published");
    }
    if (published) {
      await this.connection.sql`
        insert into replay_publications (match_id, published_at, published_by_account_id)
        values (${matchId}, now(), ${accountId}) on conflict (match_id) do update set published_at=now(), published_by_account_id=excluded.published_by_account_id
      `;
    } else await this.connection.sql`delete from replay_publications where match_id=${matchId}`;
    await this.connection.sql`insert into game_events (match_id, type, payload) values (${matchId}, 'REPLAY_PUBLICATION_CHANGED', ${jsonPayload({ published })})`;
  }

  async mayViewReplay(matchId: string, session: SessionContext): Promise<boolean> {
    const [access] = await this.connection.sql<{ allowed: boolean }[]>`
      select exists(
        select 1 from matches m where m.id=${matchId} and m.host_account_id=${session.accountId}
        union all
        select 1 from replay_publications r join participants p on p.match_id=r.match_id
          where r.match_id=${matchId} and (p.id=${session.participantId} or p.account_id=${session.accountId})
      ) as allowed
    `;
    return access?.allowed ?? false;
  }

  async getReplay(matchId: string): Promise<{ frames: ReplayFrame[]; events: unknown[]; participants: RuntimeParticipant[]; published: boolean }> {
    const frames = await this.connection.sql<ReplayFrame[]>`
      select participant_id as "participantId", recorded_at::text as "recordedAt",
        ST_Y(point::geometry) as latitude, ST_X(point::geometry) as longitude,
        accuracy_meters as "accuracyMeters", speed_mps as "speedMps", heading_degrees as "headingDegrees"
      from location_samples where match_id=${matchId} order by recorded_at, id
    `;
    const events = await this.connection.sql`
      select id, type, actor_participant_id as "actorParticipantId", target_participant_id as "targetParticipantId",
        payload, occurred_at::text as "occurredAt" from game_events where match_id=${matchId} order by occurred_at, id
    `;
    const participantsRows = await this.connection.sql<RuntimeParticipant[]>`
      select id, account_id as "accountId", display_name as "displayName", role, status from participants where match_id=${matchId}
    `;
    const [publication] = await this.connection.sql`select match_id from replay_publications where match_id=${matchId}`;
    return { frames, events: [...events], participants: participantsRows, published: Boolean(publication) };
  }

  async deleteMatch(matchId: string): Promise<void> {
    await this.connection.sql`delete from matches where id=${matchId}`;
  }
}
