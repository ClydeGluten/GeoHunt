import type { MatchSnapshot, PlayerRole, VisiblePosition } from "@geohunter/contracts";
import { useEffect, useMemo, useState } from "react";
import { api, put } from "../api";
import { MapView } from "../MapView";
import type { ReplayData } from "../types";

export function ReplayScreen({ matchId, onBack }: { matchId: string; onBack: () => void }) {
  const [replay, setReplay] = useState<ReplayData | null>(null);
  const [snapshot, setSnapshot] = useState<MatchSnapshot | null>(null);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [published, setPublished] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([api<ReplayData>(`/v1/matches/${matchId}/replay`), api<MatchSnapshot>(`/v1/matches/${matchId}`)]).then(([data, match]) => {
      setReplay(data);
      setSnapshot(match);
      setPublished(data.published);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "Replay unavailable"));
  }, [matchId]);

  const times = useMemo(() => [...new Set(replay?.frames.map((frame) => new Date(frame.recordedAt).getTime()) ?? [])].sort((a, b) => a - b), [replay]);
  useEffect(() => {
    if (!playing || cursor >= times.length - 1) return setPlaying(false);
    const timer = setTimeout(() => setCursor((value) => value + 1), Math.min(1000, Math.max(80, (times[cursor + 1] ?? 0) - (times[cursor] ?? 0))));
    return () => clearTimeout(timer);
  }, [playing, cursor, times]);

  const positions = useMemo<VisiblePosition[]>(() => {
    if (!replay || !times.length) return [];
    const currentTime = times[cursor] ?? times[0] ?? 0;
    return replay.participants.flatMap((participant) => {
      const frame = replay.frames.filter((item) => item.participantId === participant.id && new Date(item.recordedAt).getTime() <= currentTime).at(-1);
      if (!frame) return [];
      return [{ ...frame, displayName: participant.displayName, role: participant.role as PlayerRole, stale: false, frozen: false }];
    });
  }, [replay, times, cursor]);

  const togglePublish = async () => {
    try {
      const result = await put<{ published: boolean }>(`/v1/matches/${matchId}/replay/publication`, { published: !published });
      setPublished(result.published);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Publication failed");
    }
  };

  if (error && !replay) return <main className="center"><h1>Replay locked</h1><p>{error}</p><button className="primary" onClick={onBack}>Back to match</button></main>;
  if (!replay || !snapshot) return <main className="center"><div className="loader" /><p>Loading every footstep…</p></main>;

  return <main className="replay-shell">
    <div className="replay-map"><MapView polygon={snapshot.playzone} positions={positions} /></div>
    <header className="game-hud"><button className="round-button" onClick={onBack}>←</button><div className="match-pill"><small>FULL REPLAY</small><strong>{snapshot.name}</strong></div>{snapshot.viewerIsHost ? <button className="round-button" aria-label={published ? "Unpublish replay" : "Publish replay"} onClick={() => void togglePublish()}>{published ? "◉" : "◎"}</button> : <span />}</header>
    <section className="replay-controls">
      <div className="replay-meta"><span>{times.length ? new Date(times[cursor] ?? times[0] ?? 0).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "No samples"}</span><span>{replay.frames.length} points · {replay.events.length} events</span></div>
      <input aria-label="Replay timeline" type="range" min={0} max={Math.max(0, times.length - 1)} value={cursor} onChange={(event) => setCursor(Number(event.target.value))} />
      <button className="primary replay-play" disabled={!times.length} onClick={() => { if (cursor >= times.length - 1) setCursor(0); setPlaying(!playing); }}>{playing ? "Pause" : "Play replay"}</button>
      {snapshot.viewerIsHost && <p className="fine-print">{published ? "Participants can view this replay." : "Only you can view this replay until it is published."}</p>}
    </section>
  </main>;
}
