export function ReplayExportLink({ matchId }: { matchId: string }) {
  return (
    <a
      className="secondary replay-export"
      href={`/api/v1/matches/${encodeURIComponent(matchId)}/export`}
      download
    >
      Export replay
    </a>
  );
}
