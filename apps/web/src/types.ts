import type { MatchState, ReplayFrame } from "@geohunter/contracts";

export interface AuthMe {
  kind: "TELEGRAM" | "GUEST";
  account: { id: string; displayName: string } | null;
  participantId: string | null;
}

export interface MatchCard {
  id: string;
  name: string;
  state: MatchState;
  participantCount: number;
  phaseEndsAt?: string | null;
  createdAt: string;
}

export interface InvitePreview {
  matchId: string;
  name: string;
  state: MatchState;
  participantCount: number;
}

export interface ReplayData {
  frames: ReplayFrame[];
  events: Array<{ id: number; type: string; occurredAt: string }>;
  participants: Array<{ id: string; displayName: string; role: string; status: string }>;
  published: boolean;
}
