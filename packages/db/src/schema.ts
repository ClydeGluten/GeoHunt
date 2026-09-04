import {
  bigint,
  bigserial,
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const geographyPoint = customType<{ data: string }>({ dataType: () => "geography(Point,4326)" });
const geometryPolygon = customType<{ data: string }>({ dataType: () => "geometry(Polygon,4326)" });

export const matchStateEnum = pgEnum("match_state", ["DRAFT", "LOBBY", "HIDING", "ACTIVE", "PAUSED", "FINISHED", "CANCELED"]);
export const playerRoleEnum = pgEnum("player_role", ["HOST", "HIDER", "SEEKER", "SPECTATOR"]);
export const participantStatusEnum = pgEnum("participant_status", ["ACTIVE", "TAGGED", "DISQUALIFIED", "LEFT"]);
export const visibilityModeEnum = pgEnum("visibility_mode", ["NEVER", "ALWAYS", "PULSE"]);
export const caughtBehaviorEnum = pgEnum("caught_behavior", ["SEEKER", "SPECTATOR"]);
export const boundaryAudienceEnum = pgEnum("boundary_audience", ["HOST", "SEEKERS", "ALL"]);
export const sessionKindEnum = pgEnum("session_kind", ["TELEGRAM", "GUEST"]);
export const locationSourceEnum = pgEnum("location_source", ["BROWSER", "TELEGRAM"]);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    telegramUserId: bigint("telegram_user_id", { mode: "bigint" }).notNull(),
    username: varchar("username", { length: 64 }),
    firstName: varchar("first_name", { length: 128 }).notNull(),
    lastName: varchar("last_name", { length: 128 }),
    photoUrl: text("photo_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("accounts_telegram_user_id_uq").on(table.telegramUserId)],
);

export const matches = pgTable(
  "matches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hostAccountId: uuid("host_account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
    telegramChatId: bigint("telegram_chat_id", { mode: "bigint" }),
    name: varchar("name", { length: 80 }).notNull(),
    state: matchStateEnum("state").default("DRAFT").notNull(),
    stateBeforePause: matchStateEnum("state_before_pause"),
    winnerRole: playerRoleEnum("winner_role"),
    phaseStartedAt: timestamp("phase_started_at", { withTimezone: true }),
    phaseEndsAt: timestamp("phase_ends_at", { withTimezone: true }),
    activeStartedAt: timestamp("active_started_at", { withTimezone: true }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    pausedDurationMs: bigint("paused_duration_ms", { mode: "number" }).default(0).notNull(),
    emergencyReveal: boolean("emergency_reveal").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("matches_host_idx").on(table.hostAccountId), index("matches_state_idx").on(table.state)],
);

export const telegramChatOwnerships = pgTable(
  "telegram_chat_ownerships",
  {
    telegramChatId: bigint("telegram_chat_id", { mode: "bigint" }).notNull(),
    accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.telegramChatId, table.accountId] }), index("telegram_chat_ownerships_account_idx").on(table.accountId)],
);

export const matchSettings = pgTable("match_settings", {
  matchId: uuid("match_id").primaryKey().references(() => matches.id, { onDelete: "cascade" }),
  durationSeconds: integer("duration_seconds").default(3600).notNull(),
  hideSeconds: integer("hide_seconds").default(300).notNull(),
  tapTagEnabled: boolean("tap_tag_enabled").default(true).notNull(),
  autoTagEnabled: boolean("auto_tag_enabled").default(false).notNull(),
  tagRadiusMeters: doublePrecision("tag_radius_meters").default(15).notNull(),
  autoTagDwellSeconds: integer("auto_tag_dwell_seconds").default(5).notNull(),
  tagCooldownSeconds: integer("tag_cooldown_seconds").default(5).notNull(),
  positionMaxAgeSeconds: integer("position_max_age_seconds").default(15).notNull(),
  maxAccuracyMeters: doublePrecision("max_accuracy_meters").default(50).notNull(),
  maxSpeedMps: doublePrecision("max_speed_mps").default(15).notNull(),
  caughtBehavior: caughtBehaviorEnum("caught_behavior").default("SPECTATOR").notNull(),
  boundaryGraceSeconds: integer("boundary_grace_seconds").default(30).notNull(),
  boundaryAudience: boundaryAudienceEnum("boundary_audience").default("HOST").notNull(),
  boundaryDisqualify: boolean("boundary_disqualify").default(false).notNull(),
});

export const visibilityRules = pgTable(
  "visibility_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    matchId: uuid("match_id").notNull().references(() => matches.id, { onDelete: "cascade" }),
    observerRole: playerRoleEnum("observer_role").notNull(),
    targetRole: playerRoleEnum("target_role").notNull(),
    mode: visibilityModeEnum("mode").notNull(),
    visibleDurationSeconds: integer("visible_duration_seconds").default(10).notNull(),
    cyclePeriodSeconds: integer("cycle_period_seconds").default(60).notNull(),
    phaseOffsetSeconds: integer("phase_offset_seconds").default(0).notNull(),
    persistLastSeen: boolean("persist_last_seen").default(true).notNull(),
  },
  (table) => [uniqueIndex("visibility_rules_pair_uq").on(table.matchId, table.observerRole, table.targetRole)],
);

export const playzones = pgTable("playzones", {
  matchId: uuid("match_id").primaryKey().references(() => matches.id, { onDelete: "cascade" }),
  polygon: geometryPolygon("polygon").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const participants = pgTable(
  "participants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    matchId: uuid("match_id").notNull().references(() => matches.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
    displayName: varchar("display_name", { length: 40 }).notNull(),
    role: playerRoleEnum("role").default("SPECTATOR").notNull(),
    status: participantStatusEnum("status").default("ACTIVE").notNull(),
    consentLocationAt: timestamp("consent_location_at", { withTimezone: true }),
    consentReplayAt: timestamp("consent_replay_at", { withTimezone: true }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
    leftAt: timestamp("left_at", { withTimezone: true }),
    taggedAt: timestamp("tagged_at", { withTimezone: true }),
  },
  (table) => [index("participants_match_idx").on(table.matchId), uniqueIndex("participants_match_account_uq").on(table.matchId, table.accountId)],
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    matchId: uuid("match_id").notNull().references(() => matches.id, { onDelete: "cascade" }),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("invitations_code_hash_uq").on(table.codeHash), index("invitations_match_idx").on(table.matchId)],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    kind: sessionKindEnum("kind").notNull(),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id").references(() => participants.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("auth_sessions_token_hash_uq").on(table.tokenHash), index("auth_sessions_expiry_idx").on(table.expiresAt)],
);

export const latestLocations = pgTable("latest_locations", {
  participantId: uuid("participant_id").primaryKey().references(() => participants.id, { onDelete: "cascade" }),
  matchId: uuid("match_id").notNull().references(() => matches.id, { onDelete: "cascade" }),
  point: geographyPoint("point").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  accuracyMeters: doublePrecision("accuracy_meters").notNull(),
  speedMps: doublePrecision("speed_mps"),
  headingDegrees: doublePrecision("heading_degrees"),
  source: locationSourceEnum("source").notNull(),
  clientSequence: bigint("client_sequence", { mode: "number" }).notNull(),
});

export const locationSamples = pgTable(
  "location_samples",
  {
    id: bigserial("id", { mode: "number" }).notNull(),
    matchId: uuid("match_id").notNull().references(() => matches.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id").notNull().references(() => participants.id, { onDelete: "cascade" }),
    point: geographyPoint("point").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    accuracyMeters: doublePrecision("accuracy_meters").notNull(),
    speedMps: doublePrecision("speed_mps"),
    headingDegrees: doublePrecision("heading_degrees"),
    source: locationSourceEnum("source").notNull(),
    clientSequence: bigint("client_sequence", { mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.id, table.recordedAt] }), index("location_samples_match_time_idx").on(table.matchId, table.recordedAt)],
);

export const gameEvents = pgTable(
  "game_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    matchId: uuid("match_id").notNull().references(() => matches.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 64 }).notNull(),
    actorParticipantId: uuid("actor_participant_id").references(() => participants.id, { onDelete: "set null" }),
    targetParticipantId: uuid("target_participant_id").references(() => participants.id, { onDelete: "set null" }),
    point: geographyPoint("point"),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("game_events_match_time_idx").on(table.matchId, table.occurredAt)],
);

export const boundaryStates = pgTable("boundary_states", {
  participantId: uuid("participant_id").primaryKey().references(() => participants.id, { onDelete: "cascade" }),
  matchId: uuid("match_id").notNull().references(() => matches.id, { onDelete: "cascade" }),
  outsideSince: timestamp("outside_since", { withTimezone: true }),
  graceEndsAt: timestamp("grace_ends_at", { withTimezone: true }),
  actionAppliedAt: timestamp("action_applied_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const replayPublications = pgTable("replay_publications", {
  matchId: uuid("match_id").primaryKey().references(() => matches.id, { onDelete: "cascade" }),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
  publishedByAccountId: uuid("published_by_account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
});
