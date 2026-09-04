import { useEffect, useState } from "react";
import { api, post } from "../api";
import { telegram } from "../telegram";
import type { InvitePreview } from "../types";

export function JoinScreen({ inviteCode, onJoined, authenticated = false, existingGuest = false }: { inviteCode: string; onJoined: (matchId: string) => void; authenticated?: boolean; existingGuest?: boolean }) {
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [name, setName] = useState(telegram()?.initDataUnsafe?.user?.first_name ?? "");
  const [locationConsent, setLocationConsent] = useState(false);
  const [replayConsent, setReplayConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<InvitePreview>(`/v1/invites/${encodeURIComponent(inviteCode)}`).then(setPreview).catch((cause) => setError(cause instanceof Error ? cause.message : "Invite unavailable"));
  }, [inviteCode]);

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      if (existingGuest) {
        if (!preview) throw new Error("Invite is still loading");
        onJoined(preview.matchId);
        return;
      }
      if (authenticated) {
        const result = await post<{ matchId: string }>("/v1/matches/join", { inviteCode, consentLocation: locationConsent, consentReplay: replayConsent });
        onJoined(result.matchId);
      } else {
        const result = await post<{ matchId: string }>("/v1/auth/guest", { inviteCode, displayName: name, consentLocation: locationConsent, consentReplay: replayConsent });
        onJoined(result.matchId);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not join");
    } finally {
      setBusy(false);
    }
  };

  return <main className="join-shell">
    <section className="join-hero">
      <p className="eyebrow">YOU’VE BEEN INVITED</p>
      <h1>{preview?.name ?? "GeoHunter match"}</h1>
      <p>{preview ? `${preview.participantCount} players waiting · ${preview.state.toLowerCase()}` : "Checking the trail…"}</p>
    </section>
    <section className="card consent-card">
      {!authenticated && !existingGuest && <label>Your trail name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Display name" minLength={2} maxLength={40} /></label>}
      <h2>Before you enter</h2>
      <Consent checked={locationConsent} onChange={setLocationConsent} title="Share live location" text="Your accepted route is recorded for game validation and replay." />
      <Consent checked={replayConsent} onChange={setReplayConsent} title="Store the replay indefinitely" text="The host can see the full route, export it, delete the match, and publish the replay to participants." />
      <p className="warning-note">The host can trigger an emergency reveal. Everyone will be notified when it happens. Browser tracking may stop when your phone is locked.</p>
      {error && <p className="error-banner">{error}</p>}
      <button className="primary wide" disabled={busy || (existingGuest ? !preview : !locationConsent || !replayConsent || (!authenticated && name.trim().length < 2))} onClick={() => void join()}>{busy ? "Joining…" : existingGuest ? "Continue to lobby" : "Accept & join lobby"}</button>
    </section>
  </main>;
}

function Consent({ checked, onChange, title, text }: { checked: boolean; onChange: (value: boolean) => void; title: string; text: string }) {
  return <label className="consent-row">
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    <span><strong>{title}</strong><small>{text}</small></span>
  </label>;
}
