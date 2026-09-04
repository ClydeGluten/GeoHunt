import { useEffect, useMemo, useState } from "react";
import { ApiFailure, api, post } from "./api";
import { CreateScreen } from "./screens/CreateScreen";
import { Dashboard } from "./screens/Dashboard";
import { GameScreen } from "./screens/GameScreen";
import { JoinScreen } from "./screens/JoinScreen";
import { ReplayScreen } from "./screens/ReplayScreen";
import { initializeTelegram, telegram } from "./telegram";
import type { AuthMe } from "./types";

type Route =
  | { page: "home" }
  | { page: "create" }
  | { page: "game"; id: string }
  | { page: "replay"; id: string };

function initialRoute(): Route {
  const parameters = new URLSearchParams(location.search);
  if (parameters.get("create") === "1") return { page: "create" };
  const replay = parameters.get("replay");
  const match = parameters.get("match");
  if (replay) return { page: "replay", id: replay };
  if (match) return { page: "game", id: match };
  return { page: "home" };
}

export default function App() {
  const [auth, setAuth] = useState<AuthMe | null>(null);
  const [route, setRoute] = useState<Route>(initialRoute);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inviteCode = useMemo(() => {
    const parameters = new URLSearchParams(location.search);
    return (
      parameters.get("invite") ??
      telegram()?.initDataUnsafe?.start_param ??
      null
    );
  }, []);

  const navigate = (next: Route) => {
    setRoute(next);
    const params = new URLSearchParams();
    if (next.page === "game") params.set("match", next.id);
    if (next.page === "replay") params.set("replay", next.id);
    const invite = new URLSearchParams(location.search).get("invite");
    if (invite && next.page === "home") params.set("invite", invite);
    history.pushState(
      {},
      "",
      `${location.pathname}${params.size ? `?${params}` : ""}`,
    );
  };

  const refreshAuth = async () => {
    try {
      setAuth(await api<AuthMe>("/v1/auth/me"));
      setError(null);
    } catch (cause) {
      if (!(cause instanceof ApiFailure && cause.status === 401))
        setError(cause instanceof Error ? cause.message : "Could not sign in");
      setAuth(null);
    }
  };

  useEffect(() => {
    initializeTelegram();
    const boot = async () => {
      const webApp = telegram();
      if (webApp?.initData) {
        await post("/v1/auth/telegram", { initData: webApp.initData });
      }
      await refreshAuth();
      setLoading(false);
    };
    void boot().catch((cause) => {
      setError(cause instanceof Error ? cause.message : "Startup failed");
      setLoading(false);
    });
    const pop = () => setRoute(initialRoute());
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);

  if (loading)
    return (
      <main className="center">
        <div className="loader" />
        <p>Finding the trail…</p>
      </main>
    );

  if (!auth) {
    if (inviteCode)
      return (
        <JoinScreen
          inviteCode={inviteCode}
          onJoined={(id) => {
            void refreshAuth();
            navigate({ page: "game", id });
          }}
        />
      );
    return (
      <main className="welcome center">
        <div className="brand-mark">G</div>
        <p className="eyebrow">LIVE LOCATION GAME</p>
        <h1>GeoHunter Zone</h1>
        <p className="lede">
          Draw the arena. Pick the hunters. Make every street part of the chase.
        </p>
        {error && <p className="error-banner">{error}</p>}
        {(import.meta.env.DEV ||
          ["localhost", "127.0.0.1"].includes(location.hostname)) && (
          <DevLogin onReady={refreshAuth} />
        )}
        <p className="fine-print">
          Hosts sign in through Telegram. Guests enter from an invite link.
        </p>
      </main>
    );
  }

  if (inviteCode && route.page === "home")
    return (
      <JoinScreen
        authenticated={auth.kind === "TELEGRAM"}
        existingGuest={auth.kind === "GUEST"}
        inviteCode={inviteCode}
        onJoined={(id) => navigate({ page: "game", id })}
      />
    );

  if (route.page === "create")
    return (
      <CreateScreen
        onCancel={() => navigate({ page: "home" })}
        onCreated={(id) => navigate({ page: "game", id })}
      />
    );
  if (route.page === "game")
    return (
      <GameScreen
        matchId={route.id}
        onBack={() => navigate({ page: "home" })}
        onReplay={() => navigate({ page: "replay", id: route.id })}
      />
    );
  if (route.page === "replay")
    return (
      <ReplayScreen
        matchId={route.id}
        onBack={() => navigate({ page: "game", id: route.id })}
      />
    );
  return (
    <Dashboard
      auth={auth}
      inviteCode={inviteCode}
      onCreate={() => navigate({ page: "create" })}
      onOpen={(id) => navigate({ page: "game", id })}
      onJoined={(id) => navigate({ page: "game", id })}
    />
  );
}

function DevLogin({ onReady }: { onReady: () => Promise<void> }) {
  const [name, setName] = useState("Trail Master");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="card compact"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void post("/v1/auth/dev", { displayName: name })
          .then(onReady)
          .finally(() => setBusy(false));
      }}
    >
      <label>
        Local development host
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          minLength={2}
        />
      </label>
      <button className="primary" disabled={busy}>
        {busy ? "Opening…" : "Enter local demo"}
      </button>
    </form>
  );
}
