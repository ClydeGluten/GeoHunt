import type {
  CreateMatchInput,
  MatchSettings,
  PlayzonePolygon,
  VisibilityRule,
} from "@geohunter/contracts";
import { useState } from "react";
import { post } from "../api";
import { readTelegramChatGrant } from "../auth";
import { MapView } from "../MapView";

const defaultSettings: MatchSettings = {
  durationSeconds: 3600,
  hideSeconds: 300,
  tapTagEnabled: true,
  autoTagEnabled: false,
  tagRadiusMeters: 15,
  autoTagDwellSeconds: 5,
  tagCooldownSeconds: 5,
  positionMaxAgeSeconds: 15,
  maxAccuracyMeters: 50,
  maxSpeedMps: 15,
  caughtBehavior: "SPECTATOR",
  boundaryGraceSeconds: 30,
  boundaryAudience: "HOST",
  boundaryDisqualify: false,
};

const rules: VisibilityRule[] = [
  {
    observerRole: "HIDER",
    targetRole: "HIDER",
    mode: "ALWAYS",
    visibleDurationSeconds: 10,
    cyclePeriodSeconds: 60,
    phaseOffsetSeconds: 0,
    persistLastSeen: true,
  },
  {
    observerRole: "SEEKER",
    targetRole: "SEEKER",
    mode: "ALWAYS",
    visibleDurationSeconds: 10,
    cyclePeriodSeconds: 60,
    phaseOffsetSeconds: 0,
    persistLastSeen: true,
  },
  {
    observerRole: "SEEKER",
    targetRole: "HIDER",
    mode: "PULSE",
    visibleDurationSeconds: 10,
    cyclePeriodSeconds: 60,
    phaseOffsetSeconds: 0,
    persistLastSeen: true,
  },
  {
    observerRole: "HIDER",
    targetRole: "SEEKER",
    mode: "PULSE",
    visibleDurationSeconds: 10,
    cyclePeriodSeconds: 60,
    phaseOffsetSeconds: 30,
    persistLastSeen: true,
  },
  {
    observerRole: "HOST",
    targetRole: "HIDER",
    mode: "PULSE",
    visibleDurationSeconds: 10,
    cyclePeriodSeconds: 60,
    phaseOffsetSeconds: 0,
    persistLastSeen: true,
  },
  {
    observerRole: "HOST",
    targetRole: "SEEKER",
    mode: "PULSE",
    visibleDurationSeconds: 10,
    cyclePeriodSeconds: 60,
    phaseOffsetSeconds: 30,
    persistLastSeen: true,
  },
];

export function CreateScreen({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const [step, setStep] = useState<"zone" | "rules">("zone");
  const [name, setName] = useState("Friday Night Hunt");
  const [polygon, setPolygon] = useState<PlayzonePolygon | null>(null);
  const [settings, setSettings] = useState(defaultSettings);
  const [visibility, setVisibility] = useState(rules);
  const [consentLocation, setConsentLocation] = useState(false);
  const [consentReplay, setConsentReplay] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const vertexCount = Math.max(0, (polygon?.coordinates[0]?.length ?? 1) - 1);

  const create = async () => {
    if (!polygon || vertexCount < 3)
      return setError("Draw at least three corners for the playzone.");
    if (!consentLocation || !consentReplay)
      return setError(
        "Confirm both location agreements before creating the lobby.",
      );
    setBusy(true);
    setError(null);
    try {
      const telegramChatGrant = readTelegramChatGrant(
        new URLSearchParams(location.search),
      );
      const input: CreateMatchInput = {
        name,
        playzone: polygon,
        settings,
        visibilityRules: visibility,
        consentLocation: true,
        consentReplay: true,
        ...(telegramChatGrant ?? {}),
      };
      const result = await post<{ matchId: string }>("/v1/matches", input);
      onCreated(result.matchId);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not create match",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="creator">
      <header className="creator-header">
        <button className="icon-button" onClick={onCancel}>
          ←
        </button>
        <div>
          <p className="eyebrow">NEW HUNT</p>
          <h1>{step === "zone" ? "Mark the territory" : "Set the rules"}</h1>
        </div>
        <span>{step === "zone" ? "1/2" : "2/2"}</span>
      </header>
      {step === "zone" ? (
        <>
          <div className="map-wrap creator-map">
            <MapView polygon={polygon} editable onPolygonChange={setPolygon} />
          </div>
          <div className="map-tip">
            <strong>Tap the map to add corners</strong>
            <small>Drag the yellow handles to tune the boundary.</small>
          </div>
          <section className="sheet creator-sheet">
            <label>
              Match name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
              />
            </label>
            <div className="zone-summary">
              <span>
                <i>⌖</i>
                <b>{vertexCount} corners</b>
              </span>
              <button className="text-button" onClick={() => setPolygon(null)}>
                Clear zone
              </button>
            </div>
            {error && <p className="error-banner">{error}</p>}
            <button
              className="primary wide"
              disabled={vertexCount < 3 || name.trim().length < 2}
              onClick={() => setStep("rules")}
            >
              Continue to game rules
            </button>
          </section>
        </>
      ) : (
        <section className="rules-page">
          <Setting title="Round duration" hint="Minutes after the hiding phase">
            <input
              type="number"
              min={1}
              max={1440}
              value={settings.durationSeconds / 60}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  durationSeconds: Number(event.target.value) * 60,
                })
              }
            />
          </Setting>
          <Setting
            title="Hiding head start"
            hint="Seekers cannot tag during this phase"
          >
            <input
              type="number"
              min={0}
              max={120}
              value={settings.hideSeconds / 60}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  hideSeconds: Number(event.target.value) * 60,
                })
              }
            />
          </Setting>
          <Setting title="Hunter reveal" hint="How often seekers see hiders">
            <div className="inline-fields">
              <input
                type="number"
                aria-label="Reveal duration"
                min={1}
                value={
                  getPulseRule(visibility, "SEEKER")?.visibleDurationSeconds ??
                  10
                }
                onChange={(event) =>
                  setVisibility(
                    changePulse(
                      visibility,
                      "SEEKER",
                      Number(event.target.value),
                      undefined,
                    ),
                  )
                }
              />
              <span>sec every</span>
              <input
                type="number"
                aria-label="Reveal period"
                min={2}
                value={
                  getPulseRule(visibility, "SEEKER")?.cyclePeriodSeconds ?? 60
                }
                onChange={(event) =>
                  setVisibility(
                    changePulse(
                      visibility,
                      "SEEKER",
                      undefined,
                      Number(event.target.value),
                    ),
                  )
                }
              />
              <span>sec</span>
            </div>
          </Setting>
          <Setting
            title="Tag modes"
            hint="Server verifies distance and GPS quality"
          >
            <Toggle
              label="Tap to tag"
              checked={settings.tapTagEnabled}
              onChange={(value) =>
                setSettings({ ...settings, tapTagEnabled: value })
              }
            />
            <Toggle
              label="Automatic dwell tag"
              checked={settings.autoTagEnabled}
              onChange={(value) =>
                setSettings({ ...settings, autoTagEnabled: value })
              }
            />
          </Setting>
          <Setting title="Tag radius" hint="Allowed 2–100 metres">
            <div className="range-row">
              <input
                type="range"
                min={2}
                max={100}
                value={settings.tagRadiusMeters}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    tagRadiusMeters: Number(event.target.value),
                  })
                }
              />
              <b>{settings.tagRadiusMeters} m</b>
            </div>
          </Setting>
          <Setting
            title="Boundary response"
            hint="All offenders receive their own warning"
          >
            <select
              value={settings.boundaryAudience}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  boundaryAudience: event.target
                    .value as MatchSettings["boundaryAudience"],
                })
              }
            >
              <option value="HOST">Notify host</option>
              <option value="SEEKERS">Notify seekers</option>
              <option value="ALL">Notify everyone</option>
            </select>
            <Toggle
              label="Disqualify after grace"
              checked={settings.boundaryDisqualify}
              onChange={(value) =>
                setSettings({ ...settings, boundaryDisqualify: value })
              }
            />
          </Setting>
          <Setting title="Caught players" hint="What happens after a valid tag">
            <select
              value={settings.caughtBehavior}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  caughtBehavior: event.target
                    .value as MatchSettings["caughtBehavior"],
                })
              }
            >
              <option value="SPECTATOR">Become spectator</option>
              <option value="SEEKER">Join seekers</option>
            </select>
          </Setting>
          <Setting
            title="Host location agreement"
            hint="Required before this lobby can record any host gameplay"
          >
            <HostConsent
              location={consentLocation}
              replay={consentReplay}
              onLocationChange={setConsentLocation}
              onReplayChange={setConsentReplay}
            />
          </Setting>
          {error && <p className="error-banner">{error}</p>}
          <div className="sticky-actions">
            <button className="secondary" onClick={() => setStep("zone")}>
              Back
            </button>
            <button
              className="primary"
              disabled={
                busy ||
                !consentLocation ||
                !consentReplay ||
                (!settings.tapTagEnabled && !settings.autoTagEnabled)
              }
              onClick={() => void create()}
            >
              {busy ? "Creating…" : "Create lobby"}
            </button>
          </div>
        </section>
      )}
    </main>
  );
}

export function getPulseRule(
  current: VisibilityRule[],
  observerRole: "HIDER" | "SEEKER",
) {
  const targetRole = observerRole === "SEEKER" ? "HIDER" : "SEEKER";
  return current.find(
    (rule) =>
      rule.observerRole === observerRole &&
      rule.targetRole === targetRole &&
      rule.mode === "PULSE",
  );
}

export function changePulse(
  current: VisibilityRule[],
  observerRole: "HIDER" | "SEEKER",
  duration?: number,
  period?: number,
) {
  const selected = getPulseRule(current, observerRole);
  return current.map((rule) =>
    rule === selected
      ? {
          ...rule,
          visibleDurationSeconds: duration ?? rule.visibleDurationSeconds,
          cyclePeriodSeconds: period ?? rule.cyclePeriodSeconds,
        }
      : rule,
  );
}

function Setting({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="setting card">
      <div>
        <strong>{title}</strong>
        <small>{hint}</small>
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

export function HostConsent({
  location,
  replay,
  onLocationChange,
  onReplayChange,
}: {
  location: boolean;
  replay: boolean;
  onLocationChange: (checked: boolean) => void;
  onReplayChange: (checked: boolean) => void;
}) {
  return (
    <div>
      <label className="consent-row">
        <input
          type="checkbox"
          checked={location}
          onChange={(event) => onLocationChange(event.target.checked)}
        />
        <span>
          Record my location while I play
          <small>
            Recording starts only if you take a player role and the match enters
            a live phase.
          </small>
        </span>
      </label>
      <label className="consent-row">
        <input
          type="checkbox"
          checked={replay}
          onChange={(event) => onReplayChange(event.target.checked)}
        />
        <span>
          Store my route for the match replay
          <small>
            The route remains private unless the host publishes the replay to
            match participants.
          </small>
        </span>
      </label>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
