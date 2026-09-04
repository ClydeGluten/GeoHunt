import { readFile } from "node:fs/promises";
import { io, type Socket } from "socket.io-client";

interface LoadClient { cookie: string; matchId: string; latitude: number; longitude: number; }
const file = process.env.LOAD_CLIENTS_FILE;
const baseUrl = process.env.LOAD_BASE_URL ?? "http://localhost";
const durationSeconds = Number(process.env.LOAD_DURATION_SECONDS ?? 60);
if (!file) throw new Error("LOAD_CLIENTS_FILE must point to a JSON array of prepared player sessions");
const clients = JSON.parse(await readFile(file, "utf8")) as LoadClient[];
if (clients.length !== 100) throw new Error(`Expected exactly 100 load clients, received ${clients.length}`);

let accepted = 0;
let rejected = 0;
let sequence = Date.now();
const sockets: Socket[] = clients.map((client, index) => {
  const socket = io(baseUrl, {
    path: "/socket.io",
    auth: { matchId: client.matchId },
    transports: ["websocket"],
    extraHeaders: { cookie: client.cookie },
    reconnection: true,
  });
  const timer = setInterval(() => {
    const angle = (Date.now() / 10_000 + index) % (Math.PI * 2);
    socket.emit("location:update", {
      matchId: client.matchId,
      latitude: client.latitude + Math.sin(angle) * 0.00002,
      longitude: client.longitude + Math.cos(angle) * 0.00002,
      accuracyMeters: 8,
      speedMps: 1,
      headingDegrees: null,
      recordedAt: new Date().toISOString(),
      clientSequence: sequence++,
      source: "BROWSER",
    }, (result: { accepted: boolean }) => result.accepted ? accepted++ : rejected++);
  }, 5000);
  timer.unref();
  return socket;
});

setTimeout(() => sockets.filter((_, index) => index % 10 === 0).forEach((socket) => { socket.disconnect(); socket.connect(); }), Math.max(5000, durationSeconds * 500));
await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1000));
sockets.forEach((socket) => socket.disconnect());
process.stdout.write(JSON.stringify({ clients: sockets.length, accepted, rejected, durationSeconds }) + "\n");
if (accepted === 0) process.exitCode = 1;
