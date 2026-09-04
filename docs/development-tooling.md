# Free development tooling research

Checked against the primary GitHub repositories on 2026-08-21.

## Use now

- [MapLibre Agent Skills](https://github.com/maplibre/maplibre-agent-skills) — MIT, community-maintained guidance for tile sources, PMTiles, Mapbox migration, terrain, and cartography. All five skills are installed project-locally in `.agents/skills`.
- [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp) — Apache-2.0 browser automation using accessibility snapshots. Useful for browser inspection and exploratory E2E work; ordinary Playwright tests remain the repeatable CI layer.
- [Mobile MCP](https://github.com/mobile-next/mobile-mcp) — Apache-2.0 automation for Android/iOS emulators, simulators, and devices. Android can run from common desktop hosts; iOS simulator/device work still needs macOS/Xcode.
- [Postgres MCP Pro](https://github.com/crystaldba/postgres-mcp) — MIT schema, query-plan, health, and index analysis. Connect only with the Compose-created `geohunter_mcp` read-only account.
- [OpenStreetMap MCP Server](https://github.com/cyanheads/openstreetmap-mcp-server) — Apache-2.0 geocoding, reverse geocoding, and Overpass exploration. This replaces the original plan's unavailable `jagan-shanmugam/open-street-map-mcp` link. Use it during development only and respect Nominatim/Overpass policies; it is not runtime game infrastructure.

## Add when map operations grow

- [QGIS MCP](https://github.com/nkarasiak/qgis-mcp) — GPL-2.0 runtime control of QGIS for layer editing, processing, rendering, and spatial database work. Valuable if regional/self-hosted map production is introduced.
- [QGIS spatial skills](https://github.com/Impertio-Studio/QGIS-Claude-Skill-Package) — MIT PyQGIS skills. The project has moved under the OpenAEC Foundation even though the historical URL redirects.

## Native-app path only

- [Expo Skills](https://github.com/expo/skills) — official MIT Expo/React Native agent skills.
- [XcodeBuildMCP](https://github.com/getsentry/XcodeBuildMCP) — MIT iOS/macOS build, simulator, test, and device tooling; requires macOS and Xcode.

V1 remains a browser PWA, so Unity/Godot tooling and native application pipelines add complexity without helping the map-first game loop.

## Suggested Codex MCP configuration

```toml
[mcp_servers.playwright]
command = "npx"
args = ["@playwright/mcp@latest"]

[mcp_servers.mobile]
command = "npx"
args = ["-y", "@mobilenext/mobile-mcp@latest"]
```

Pin versions or commit hashes in shared/CI configurations. Treat every MCP as code execution with the permissions of its process; keep database access read-only and do not expose device or QGIS control servers to untrusted networks.
