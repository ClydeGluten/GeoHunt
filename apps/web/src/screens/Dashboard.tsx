import { useEffect, useState } from "react";
import { api, post } from "../api";
import type { AuthMe, InvitePreview, MatchCard } from "../types";

export function Dashboard({
  auth,
  inviteCode,
  onCreate,
  onOpen,
  onJoined,
}: {
  auth: AuthMe;
  inviteCode: string | null;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onJoined: (id: string) => void;
}) {
  const [matches, setMatches] = useState<MatchCard[]>([]);
  const [invite, setInvite] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);

  useEffect(() => {
    void api<MatchCard[]>("/v1/matches")
      .then(setMatches)
      .catch((cause) =>
        setError(
          cause instanceof Error ? cause.message : "Could not load matches",
        ),
      );
    if (inviteCode) {
      void api<InvitePreview>(`/v1/invites/${encodeURIComponent(inviteCode)}`)
        .then(setInvite)
        .catch(() => undefined);
    }
  }, [inviteCode]);

  const join = async () => {
    if (!inviteCode) return;
    try {
      const result = await post<{ matchId: string }>("/v1/matches/join", {
        inviteCode,
      });
      onJoined(result.matchId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not join");
    }
  };

  const signOut = async () => {
    setAccountBusy(true);
    try {
      await post<void>("/v1/auth/logout");
      location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign out");
      setAccountBusy(false);
    }
  };

  const deleteData = async () => {
    if (
      !window.confirm(
        "Permanently delete this identity, its participation data, and every match it hosts?",
      )
    )
      return;
    setAccountBusy(true);
    try {
      await api<void>("/v1/account", { method: "DELETE" });
      location.reload();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not delete your data",
      );
      setAccountBusy(false);
    }
  };

  return (
    <main className="dashboard">
      <header className="topbar">
        <div>
          <p className="eyebrow">GEOHUNTER ZONE</p>
          <h1>
            Ready, {auth.account?.displayName?.split(" ")[0] ?? "hunter"}?
          </h1>
        </div>
        <span className="signal">
          <i /> LIVE
        </span>
      </header>
      {invite && (
        <button className="invite-banner" onClick={() => void join()}>
          <span>
            <small>INVITE WAITING</small>
            <strong>{invite.name}</strong>
          </span>
          <b>Join →</b>
        </button>
      )}
      <section className="dashboard-actions">
        <button className="create-card" onClick={onCreate}>
          <span className="plus">+</span>
          <span>
            <strong>Create a hunt</strong>
            <small>Draw a zone and set the rules</small>
          </span>
        </button>
      </section>
      <section>
        <div className="section-title">
          <h2>Your matches</h2>
          <span>{matches.length}</span>
        </div>
        {error && <p className="error-banner">{error}</p>}
        {!matches.length && (
          <div className="empty">
            <div>⌖</div>
            <h3>No trails yet</h3>
            <p>Your hosted matches will appear here.</p>
          </div>
        )}
        <div className="match-list">
          {matches.map((match) => (
            <button
              className="match-card"
              key={match.id}
              onClick={() => onOpen(match.id)}
            >
              <div className={`state-dot state-${match.state.toLowerCase()}`} />
              <span>
                <strong>{match.name}</strong>
                <small>
                  {match.participantCount} players · {labelState(match.state)}
                </small>
              </span>
              <b>›</b>
            </button>
          ))}
        </div>
      </section>
      <section className="account-controls" aria-label="Account and privacy">
        <p>
          Location history belongs to the identity that recorded it. You can
          leave this browser session or erase that identity and its hosted
          matches.
        </p>
        <div>
          <button disabled={accountBusy} onClick={() => void signOut()}>
            Sign out
          </button>
          <button
            className="danger-link"
            disabled={accountBusy}
            onClick={() => void deleteData()}
          >
            Delete my data
          </button>
        </div>
      </section>
    </main>
  );
}

function labelState(state: MatchCard["state"]) {
  return {
    DRAFT: "Draft",
    LOBBY: "Lobby open",
    HIDING: "Hiding",
    ACTIVE: "In progress",
    PAUSED: "Paused",
    FINISHED: "Finished",
    CANCELED: "Canceled",
  }[state];
}
