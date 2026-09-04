import { useState } from "react";
import { post } from "./api";

export function BrowserLogin({ onReady }: { onReady: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="card compact"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        void post("/v1/auth/web", { displayName: name })
          .then(onReady)
          .catch((cause) =>
            setError(
              cause instanceof Error ? cause.message : "Could not sign in",
            ),
          )
          .finally(() => setBusy(false));
      }}
    >
      <label>
        Your trail name
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          minLength={2}
          maxLength={40}
          autoComplete="nickname"
          required
        />
      </label>
      {error && <p className="error-banner">{error}</p>}
      <button className="primary" disabled={busy || name.trim().length < 2}>
        {busy ? "Opening…" : "Continue in browser"}
      </button>
    </form>
  );
}
