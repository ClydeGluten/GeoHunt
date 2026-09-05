export function DemoBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <aside className="demo-banner" aria-label="Demo match introduction">
      <button
        type="button"
        className="demo-banner-close"
        aria-label="Dismiss demo introduction"
        onClick={onDismiss}
      >
        ×
      </button>
      <strong>Hi, this is a demo match for GeoHunt!</strong>
      <p>
        This screen shows several players following predetermined paths, so you
        can see how a real game plays out live. Feel free to check out the
        replay afterward—it will be ready once the demo finishes.
      </p>
    </aside>
  );
}
