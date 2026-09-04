import { z } from "zod";

export const MatchStateSchema = z.enum([
  "DRAFT",
  "LOBBY",
  "HIDING",
  "ACTIVE",
  "PAUSED",
  "FINISHED",
  "CANCELED",
]);
export type MatchState = z.infer<typeof MatchStateSchema>;

export const PlayerRoleSchema = z.enum(["HOST", "HIDER", "SEEKER", "SPECTATOR"]);
export type PlayerRole = z.infer<typeof PlayerRoleSchema>;

export const VisibilityModeSchema = z.enum(["NEVER", "ALWAYS", "PULSE"]);
export type VisibilityMode = z.infer<typeof VisibilityModeSchema>;

export const CaughtBehaviorSchema = z.enum(["SEEKER", "SPECTATOR"]);
export type CaughtBehavior = z.infer<typeof CaughtBehaviorSchema>;

export const BoundaryAudienceSchema = z.enum(["HOST", "SEEKERS", "ALL"]);
export type BoundaryAudience = z.infer<typeof BoundaryAudienceSchema>;

export const LocationSourceSchema = z.enum(["BROWSER", "TELEGRAM"]);
export type LocationSource = z.infer<typeof LocationSourceSchema>;

export const PositionSchema = z.object({
  latitude: z.number().gte(-90).lte(90),
  longitude: z.number().gte(-180).lte(180),
  accuracyMeters: z.number().positive().max(10_000),
  speedMps: z.number().nonnegative().max(200).nullable().default(null),
  headingDegrees: z.number().gte(0).lte(360).nullable().default(null),
  recordedAt: z.iso.datetime(),
});
export type Position = z.infer<typeof PositionSchema>;

export const LocationUpdateSchema = PositionSchema.extend({
  matchId: z.uuid(),
  clientSequence: z.number().int().nonnegative(),
  source: LocationSourceSchema.default("BROWSER"),
});
export type LocationUpdate = z.infer<typeof LocationUpdateSchema>;

export const PolygonSchema = z.object({
  type: z.literal("Polygon"),
  coordinates: z
    .array(z.array(z.tuple([z.number().gte(-180).lte(180), z.number().gte(-90).lte(90)])))
    .min(1)
    .refine((rings) => (rings[0]?.length ?? 0) >= 4, "Polygon needs at least three vertices plus closing point"),
});
export type PlayzonePolygon = z.infer<typeof PolygonSchema>;

export const VisibilityRuleSchema = z
  .object({
    observerRole: PlayerRoleSchema,
    targetRole: PlayerRoleSchema,
    mode: VisibilityModeSchema,
    visibleDurationSeconds: z.number().int().min(1).max(3600).default(10),
    cyclePeriodSeconds: z.number().int().min(2).max(86_400).default(60),
    phaseOffsetSeconds: z.number().int().min(0).max(86_400).default(0),
    persistLastSeen: z.boolean().default(true),
  })
  .superRefine((rule, context) => {
    if (rule.mode === "PULSE" && rule.visibleDurationSeconds >= rule.cyclePeriodSeconds) {
      context.addIssue({
        code: "custom",
        path: ["visibleDurationSeconds"],
        message: "Pulse duration must be shorter than cycle period",
      });
    }
  });
export type VisibilityRule = z.infer<typeof VisibilityRuleSchema>;

export const MatchSettingsSchema = z
  .object({
    durationSeconds: z.number().int().min(60).max(86_400).default(3600),
    hideSeconds: z.number().int().min(0).max(7200).default(300),
    tapTagEnabled: z.boolean().default(true),
    autoTagEnabled: z.boolean().default(false),
    tagRadiusMeters: z.number().min(2).max(100).default(15),
    autoTagDwellSeconds: z.number().int().min(1).max(120).default(5),
    tagCooldownSeconds: z.number().int().min(0).max(300).default(5),
    positionMaxAgeSeconds: z.number().int().min(2).max(120).default(15),
    maxAccuracyMeters: z.number().min(5).max(500).default(50),
    maxSpeedMps: z.number().min(1).max(100).default(15),
    caughtBehavior: CaughtBehaviorSchema.default("SPECTATOR"),
    boundaryGraceSeconds: z.number().int().min(0).max(1800).default(30),
    boundaryAudience: BoundaryAudienceSchema.default("HOST"),
    boundaryDisqualify: z.boolean().default(false),
  })
  .refine((settings) => settings.tapTagEnabled || settings.autoTagEnabled, {
    message: "At least one tag mode must be enabled",
    path: ["tapTagEnabled"],
  });
export type MatchSettings = z.infer<typeof MatchSettingsSchema>;

export const CreateMatchSchema = z.object({
  name: z.string().trim().min(2).max(80),
  telegramChatId: z.string().regex(/^-?\d+$/).nullable().optional(),
  playzone: PolygonSchema,
  settings: MatchSettingsSchema,
  visibilityRules: z.array(VisibilityRuleSchema).max(16),
});
export type CreateMatchInput = z.infer<typeof CreateMatchSchema>;

export const UpdateMatchSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  playzone: PolygonSchema.optional(),
  settings: MatchSettingsSchema.optional(),
  visibilityRules: z.array(VisibilityRuleSchema).max(16).optional(),
});
export type UpdateMatchInput = z.infer<typeof UpdateMatchSchema>;

export const GuestAuthSchema = z.object({
  inviteCode: z.string().trim().min(8).max(128),
  displayName: z.string().trim().min(2).max(40),
  consentLocation: z.literal(true),
  consentReplay: z.literal(true),
});

export const JoinMatchSchema = z.object({
  inviteCode: z.string().trim().min(8).max(128),
  consentLocation: z.literal(true),
  consentReplay: z.literal(true),
});

export const TelegramAuthSchema = z.object({ initData: z.string().min(20).max(16_384) });

export const MatchActionSchema = z.object({
  action: z.enum(["OPEN_LOBBY", "START", "PAUSE", "RESUME", "END", "CANCEL", "EMERGENCY_REVEAL_ON", "EMERGENCY_REVEAL_OFF"]),
});
export type MatchAction = z.infer<typeof MatchActionSchema>["action"];

export const AssignRoleSchema = z.object({ role: PlayerRoleSchema.exclude(["HOST"]) });
export const ModerationActionSchema = z.object({ action: z.enum(["SPECTATE", "DISQUALIFY", "REMOVE"]) });

export const TagAttemptSchema = z.object({
  matchId: z.uuid(),
  targetParticipantId: z.uuid(),
  attemptedAt: z.iso.datetime(),
});
export type TagAttempt = z.infer<typeof TagAttemptSchema>;

export interface PublicParticipant {
  id: string;
  displayName: string;
  role: PlayerRole;
  status: "ACTIVE" | "TAGGED" | "DISQUALIFIED" | "LEFT";
  connected: boolean;
}

export interface VisiblePosition extends Position {
  participantId: string;
  displayName: string;
  role: PlayerRole;
  stale: boolean;
  frozen: boolean;
}

export interface MatchSnapshot {
  id: string;
  name: string;
  state: MatchState;
  viewerParticipantId: string;
  viewerRole: PlayerRole;
  viewerIsHost: boolean;
  playzone: PlayzonePolygon;
  settings: MatchSettings;
  participants: PublicParticipant[];
  visiblePositions: VisiblePosition[];
  phaseEndsAt: string | null;
  emergencyReveal: boolean;
}

export interface GameEvent {
  id: number;
  type: string;
  occurredAt: string;
  actorParticipantId: string | null;
  targetParticipantId: string | null;
  payload: Record<string, unknown>;
}

export interface ReplayFrame {
  participantId: string;
  recordedAt: string;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  speedMps: number | null;
  headingDegrees: number | null;
}

export interface ServerToClientEvents {
  "match:snapshot": (snapshot: MatchSnapshot) => void;
  "phase:changed": (payload: { state: MatchState; phaseEndsAt: string | null }) => void;
  "visibility:update": (payload: { positions: VisiblePosition[] }) => void;
  "participant:tagged": (payload: { participantId: string; newRole: PlayerRole }) => void;
  "boundary:update": (payload: { participantId: string; outside: boolean; graceEndsAt: string | null }) => void;
  "presence:update": (payload: { participantId: string; connected: boolean }) => void;
  "match:finished": (payload: { winnerRole: "HIDER" | "SEEKER" | null }) => void;
  "game:error": (payload: { code: string; message: string }) => void;
}

export interface ClientToServerEvents {
  "location:update": (payload: LocationUpdate, acknowledge?: (result: { accepted: boolean; reason?: string }) => void) => void;
  "location:status": (payload: { matchId: string; status: "DENIED" }) => void;
  "tag:attempt": (payload: TagAttempt, acknowledge?: (result: { accepted: boolean; reason?: string }) => void) => void;
  "presence:heartbeat": (payload: { matchId: string }) => void;
}
