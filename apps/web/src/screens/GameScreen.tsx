import type { ClientToServerEvents, LocationUpdate, MatchAction, MatchSnapshot, PlayerRole, ServerToClientEvents } from "@geohunter/contracts";
import { io, type Socket } from "socket.io-client";
import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { api, post, put } from "../api";
import { MapView } from "../MapView";
import { hapticError, hapticSuccess, requestTelegramLocation, telegram } from "../telegram";

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type TrackingState = "ASKING" | "LIVE" | "POOR" | "DENIED" | "OFF";

export function GameScreen({ matchId, onBack, onReplay }: { matchId: string; onBack: () => void; onReplay: () => void }) {
  const [snapshot, setSnapshot] = useState<MatchSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [tracking, setTracking] = useState<TrackingState>("OFF");
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [boundary, setBoundary] = useState<{ outside: boolean; graceEndsAt: string | null } | null>(null);
  const [panel, setPanel] = useState<"players" | "invite" | null>(null);
  const [invite, setInvite] = useState<{ inviteCode: string; inviteUrl: string; qr: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const socketRef = useRef<GameSocket | null>(null);
  const sequence = useRef(Date.now());
  const lastSent = useRef<{ latitude: number; longitude: number; at: number } | null>(null);
  const viewerId = useRef<string | null>(null);

  useEffect(() => {
    const socket: GameSocket = io({ auth: { matchId }, transports: ["websocket", "polling"], withCredentials: true });
    socketRef.current = socket;
    socket.on("connect", () => { setConnected(true); socket.emit("presence:heartbeat", { matchId }); });
    socket.on("disconnect", () => setConnected(false));
    socket.on("match:snapshot", (next) => { if (next.id === matchId) { viewerId.current = next.viewerParticipantId; setSnapshot(next); } });
    socket.on("phase:changed", (phase) => setSnapshot((current) => current ? { ...current, ...phase } : current));
    socket.on("visibility:update", ({ positions }) => setSnapshot((current) => {
      if (!current) return current;
      const next = new Map(current.visiblePositions.map((position) => [position.participantId, position]));
      positions.forEach((position) => next.set(position.participantId, position));
      return { ...current, visiblePositions: [...next.values()] };
    }));
    socket.on("participant:tagged", ({ participantId, newRole }) => {
      hapticSuccess();
      setMessage("Tag confirmed");
      setSnapshot((current) => current ? { ...current, participants: current.participants.map((player) => player.id === participantId ? { ...player, role: newRole, status: "TAGGED" } : player) } : current);
    });
    socket.on("boundary:update", (update) => {
      if (update.participantId === viewerId.current) { setBoundary(update); if (update.outside) hapticError(); }
      else if (update.outside) setMessage(`${snapshot?.participants.find((player) => player.id === update.participantId)?.displayName ?? "A player"} left the playzone`);
    });
    socket.on("presence:update", ({ participantId, connected: online }) => setSnapshot((current) => current ? { ...current, participants: current.participants.map((player) => player.id === participantId ? { ...player, connected: online } : player) } : current));
    socket.on("match:finished", ({ winnerRole }) => setMessage(winnerRole ? `${winnerRole === "HIDER" ? "Hiders" : "Seekers"} win` : "Match finished"));
    socket.on("game:error", ({ message: errorMessage }) => { setMessage(errorMessage); hapticError(); });
    void api<MatchSnapshot>(`/v1/matches/${matchId}`).then((next) => { viewerId.current = next.viewerParticipantId; setSnapshot(next); }).catch((cause) => setMessage(cause instanceof Error ? cause.message : "Match unavailable"));
    return () => { socket.disconnect(); socketRef.current = null; };
  }, [matchId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
      socketRef.current?.emit("presence:heartbeat", { matchId });
    }, 1000);
    return () => clearInterval(timer);
  }, [matchId]);

  const sendPosition = (position: { latitude: number; longitude: number; accuracy: number; speed: number | null; heading: number | null }, source: "BROWSER" | "TELEGRAM") => {
    const time = Date.now();
    const previous = lastSent.current;
    const moved = !previous || distanceApprox(previous, position) > 3;
    if (previous && !moved && time - previous.at < 5000) return;
    lastSent.current = { latitude: position.latitude, longitude: position.longitude, at: time };
    setAccuracy(position.accuracy);
    setTracking(position.accuracy <= (snapshot?.settings.maxAccuracyMeters ?? 50) ? "LIVE" : "POOR");
    const update: LocationUpdate = {
      matchId,
      latitude: position.latitude,
      longitude: position.longitude,
      accuracyMeters: position.accuracy,
      speedMps: position.speed,
      headingDegrees: position.heading,
      recordedAt: new Date().toISOString(),
      clientSequence: sequence.current++,
      source,
    };
    socketRef.current?.emit("location:update", update, (result) => {
      if (!result.accepted && result.reason === "INACCURATE") setTracking("POOR");
    });
  };

  const startTracking = () => {
    setTracking("ASKING");
    let telegramTimer: number | null = null;
    const startTelegram = () => {
      if (telegramTimer !== null) return;
      const update = () => void telegramTracking(sendPosition, setTracking).then((available) => {
        if (!available) socketRef.current?.emit("location:status", { matchId, status: "DENIED" });
      });
      update();
      telegramTimer = window.setInterval(update, 5000);
    };
    if (!navigator.geolocation) {
      startTelegram();
      return () => { if (telegramTimer !== null) clearInterval(telegramTimer); };
    }
    const watch = navigator.geolocation.watchPosition(
      ({ coords }) => sendPosition({ latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy, speed: coords.speed, heading: coords.heading }, "BROWSER"),
      startTelegram,
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15_000 },
    );
    return () => { navigator.geolocation.clearWatch(watch); if (telegramTimer !== null) clearInterval(telegramTimer); };
  };

  useEffect(() => {
    if (!snapshot || tracking !== "OFF") return;
    const stop = startTracking();
    return stop;
  }, [snapshot?.id]);

  const action = async (value: MatchAction) => {
    try {
      const result = await post<{ state: MatchSnapshot["state"] }>(`/v1/matches/${matchId}/actions`, { action: value });
      setSnapshot((current) => current ? { ...current, state: result.state } : current);
      hapticSuccess();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Action rejected");
      hapticError();
    }
  };

  const openInvite = async () => {
    setPanel("invite");
    try {
      const created = await post<{ inviteCode: string; inviteUrl: string }>(`/v1/matches/${matchId}/invite`);
      setInvite({ ...created, qr: await QRCode.toDataURL(created.inviteUrl, { margin: 1, color: { dark: "#071813", light: "#f6fff9" } }) });
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not create invite");
    }
  };

  const assignRole = async (participantId: string, role: PlayerRole) => {
    await put(`/v1/matches/${matchId}/participants/${participantId}/role`, { role });
    setSnapshot((current) => current ? { ...current, participants: current.participants.map((player) => player.id === participantId ? { ...player, role } : player) } : current);
  };

  const moderate = async (participantId: string, actionValue: "SPECTATE" | "DISQUALIFY" | "REMOVE") => {
    await post(`/v1/matches/${matchId}/participants/${participantId}/moderation`, { action: actionValue });
    setSnapshot(await api<MatchSnapshot>(`/v1/matches/${matchId}`));
  };

  const attemptTag = (targetParticipantId: string) => socketRef.current?.emit("tag:attempt", { matchId, targetParticipantId, attemptedAt: new Date().toISOString() }, (result) => {
    if (!result.accepted) { setMessage(result.reason ?? "Tag rejected"); hapticError(); }
  });

  if (!snapshot) return <main className="center"><div className="loader" /><p>{message ?? "Joining the match…"}</p><button className="text-button" onClick={onBack}>Back</button></main>;
  const host = snapshot.viewerIsHost;
  const displayedViewerRole = snapshot.viewerRole === "HOST" ? "SPECTATOR" : snapshot.viewerRole;
  const secondsLeft = snapshot.phaseEndsAt ? Math.max(0, Math.ceil((new Date(snapshot.phaseEndsAt).getTime() - now) / 1000)) : null;

  return <main className="game-shell">
    <div className="game-map"><MapView polygon={snapshot.playzone} positions={snapshot.visiblePositions} /></div>
    <header className="game-hud">
      <button className="round-button" onClick={onBack}>←</button>
      <div className="match-pill"><small>{snapshot.state}</small><strong>{secondsLeft === null ? "--:--" : formatTime(secondsLeft)}</strong></div>
      <button className="round-button" onClick={() => setPanel("players")}>☰</button>
    </header>
    <div className="status-stack">
      <Status tone={connected ? "good" : "bad"}>{connected ? "Connected" : "Reconnecting"}</Status>
      <Status tone={tracking === "LIVE" ? "good" : tracking === "POOR" || tracking === "DENIED" ? "bad" : "neutral"}>{trackingLabel(tracking, accuracy)}</Status>
      {boundary?.outside && <Status tone="bad">Outside zone · {boundary.graceEndsAt ? `${Math.max(0, Math.ceil((new Date(boundary.graceEndsAt).getTime() - now) / 1000))}s` : "return now"}</Status>}
      {snapshot.emergencyReveal && <Status tone="bad">Emergency reveal active</Status>}
    </div>
    <section className="game-bottom">
      <div className="role-line"><span className={`role role-${displayedViewerRole.toLowerCase()}`}>{displayedViewerRole}</span><span>{snapshot.visiblePositions.length} visible · {snapshot.participants.filter((p) => p.connected).length} online</span></div>
      {message && <button className="toast" onClick={() => setMessage(null)}>{message}</button>}
      {snapshot.viewerRole === "SEEKER" && snapshot.state === "ACTIVE" && <div className="tag-strip">{snapshot.participants.filter((player) => player.role === "HIDER" && player.status === "ACTIVE").map((player) => <button key={player.id} onClick={() => attemptTag(player.id)}>Tag {player.displayName}</button>)}</div>}
      {host && <HostControls state={snapshot.state} emergency={snapshot.emergencyReveal} onAction={action} onInvite={() => void openInvite()} onReplay={onReplay} />}
    </section>
    {panel === "players" && <PlayerPanel snapshot={snapshot} host={host} onClose={() => setPanel(null)} onAssign={(id, role) => void assignRole(id, role)} onModerate={(id, value) => void moderate(id, value)} onBalance={async () => { await post(`/v1/matches/${matchId}/participants/balance`); setSnapshot(await api<MatchSnapshot>(`/v1/matches/${matchId}`)); }} />}
    {panel === "invite" && <InvitePanel invite={invite} onClose={() => setPanel(null)} />}
  </main>;
}

function HostControls({ state, emergency, onAction, onInvite, onReplay }: { state: MatchSnapshot["state"]; emergency: boolean; onAction: (action: MatchAction) => void; onInvite: () => void; onReplay: () => void }) {
  return <div className="host-controls">
    {state === "DRAFT" && <button className="primary" onClick={() => void onAction("OPEN_LOBBY")}>Open lobby</button>}
    {state === "LOBBY" && <button className="primary" onClick={() => void onAction("START")}>Start hunt</button>}
    {(["HIDING", "ACTIVE"] as const).includes(state as "HIDING" | "ACTIVE") && <button className="primary" onClick={() => void onAction("PAUSE")}>Pause</button>}
    {state === "PAUSED" && <button className="primary" onClick={() => void onAction("RESUME")}>Resume</button>}
    {!(["FINISHED", "CANCELED"] as string[]).includes(state) && <button className="secondary" onClick={onInvite}>Invite</button>}
    {(["HIDING", "ACTIVE", "PAUSED"] as string[]).includes(state) && <button className="danger" onClick={() => { if (confirm(emergency ? "Stop the emergency reveal?" : "Reveal every live position to the host? Players will be notified.")) void onAction(emergency ? "EMERGENCY_REVEAL_OFF" : "EMERGENCY_REVEAL_ON"); }}>{emergency ? "End reveal" : "Emergency"}</button>}
    {(["HIDING", "ACTIVE", "PAUSED"] as string[]).includes(state) && <button className="text-button" onClick={() => { if (confirm("Finish this match now?")) void onAction("END"); }}>End</button>}
    {state === "FINISHED" && <button className="primary" onClick={onReplay}>View replay</button>}
  </div>;
}

function PlayerPanel({ snapshot, host, onClose, onAssign, onModerate, onBalance }: { snapshot: MatchSnapshot; host: boolean; onClose: () => void; onAssign: (id: string, role: PlayerRole) => void; onModerate: (id: string, action: "SPECTATE" | "DISQUALIFY" | "REMOVE") => void; onBalance: () => Promise<void> }) {
  return <div className="scrim" onClick={onClose}><section className="drawer" onClick={(event) => event.stopPropagation()}><div className="drawer-head"><div><p className="eyebrow">LOBBY</p><h2>{snapshot.participants.length} players</h2></div><button className="icon-button" onClick={onClose}>×</button></div>
    {host && ["DRAFT", "LOBBY"].includes(snapshot.state) && <button className="secondary wide balance-button" onClick={() => void onBalance()}>Auto-balance teams</button>}
    <div className="player-list">{snapshot.participants.map((player) => {
      const isOwner = host && player.id === snapshot.viewerParticipantId;
      const displayedRole = player.role === "HOST" ? "SPECTATOR" : player.role;
      return <div className="player-row" key={player.id}>
        <span className={`avatar avatar-${displayedRole.toLowerCase()}`}>{player.displayName.slice(0, 1).toUpperCase()}</span>
        <span><strong>{player.displayName}{isOwner ? " (host)" : ""}</strong><small>{player.connected ? "online" : "offline"} · {player.status.toLowerCase()}</small></span>
        {host && ["DRAFT", "LOBBY"].includes(snapshot.state)
          ? <select aria-label={`Role for ${player.displayName}`} value={displayedRole} onChange={(event) => onAssign(player.id, event.target.value as Exclude<PlayerRole, "HOST">)}>
              <option value="HIDER">Hider</option>
              <option value="SEEKER">Seeker</option>
              <option value="SPECTATOR">{isOwner ? "Referee (spectator)" : "Spectator"}</option>
            </select>
          : host && !isOwner
            ? <select value="" aria-label={`Moderate ${player.displayName}`} onChange={(event) => onModerate(player.id, event.target.value as "SPECTATE" | "DISQUALIFY" | "REMOVE")}><option value="" disabled>Moderate</option><option value="SPECTATE">Spectate</option><option value="DISQUALIFY">Disqualify</option><option value="REMOVE">Remove</option></select>
            : <b>{displayedRole}</b>}
      </div>;
    })}</div>
  </section></div>;
}

function InvitePanel({ invite, onClose }: { invite: { inviteCode: string; inviteUrl: string; qr: string } | null; onClose: () => void }) {
  const share = () => {
    if (!invite) return;
    if (telegram()) telegram()?.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(invite.inviteUrl)}&text=${encodeURIComponent("Join my GeoHunter game")}`);
    else if (navigator.share) void navigator.share({ title: "GeoHunter Zone", url: invite.inviteUrl });
    else void navigator.clipboard.writeText(invite.inviteUrl);
  };
  return <div className="scrim" onClick={onClose}><section className="drawer invite-drawer" onClick={(event) => event.stopPropagation()}><div className="drawer-head"><div><p className="eyebrow">BRING THE CREW</p><h2>Invite players</h2></div><button className="icon-button" onClick={onClose}>×</button></div>{invite ? <><img className="qr" src={invite.qr} alt="Match invite QR code" /><code>{invite.inviteCode}</code><button className="primary wide" onClick={share}>Share invite</button></> : <div className="loader" />}</section></div>;
}

function Status({ tone, children }: { tone: "good" | "bad" | "neutral"; children: React.ReactNode }) { return <span className={`status status-${tone}`}>{children}</span>; }
function formatTime(seconds: number) { return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`; }
function trackingLabel(state: TrackingState, accuracy: number | null) { if (state === "LIVE") return `GPS ±${Math.round(accuracy ?? 0)}m`; if (state === "POOR") return `Weak GPS ±${Math.round(accuracy ?? 0)}m`; if (state === "DENIED") return "Location denied"; if (state === "ASKING") return "Requesting GPS"; return "GPS off"; }
function distanceApprox(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) { const x = (b.longitude - a.longitude) * Math.cos((a.latitude * Math.PI) / 180); const y = b.latitude - a.latitude; return Math.sqrt(x * x + y * y) * 111_320; }
async function telegramTracking(send: (position: { latitude: number; longitude: number; accuracy: number; speed: number | null; heading: number | null }, source: "TELEGRAM") => void, setState: (state: TrackingState) => void): Promise<boolean> {
  const location = await requestTelegramLocation();
  if (!location) { setState("DENIED"); return false; }
  send({ latitude: location.latitude, longitude: location.longitude, accuracy: location.horizontal_accuracy ?? 100, speed: location.speed, heading: location.course }, "TELEGRAM");
  return true;
}
