import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";

import { decodeServerMessage } from "@four/shared";
import WebSocket from "ws";

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate smoke-test port");
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForHttp(url, child) {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Production server exited early with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // The child may still be binding its socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for production HTTP server");
}

const port = await freePort();
const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, NODE_ENV: "production", WS_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });

try {
  const rootUrl = `http://127.0.0.1:${port}`;
  const response = await waitForHttp(rootUrl, child);
  const html = await response.text();
  if (!html.includes("<title>Four</title>")) throw new Error("Production HTML was not served");
  const assetPath = html.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1];
  if (!assetPath) throw new Error("Production HTML did not reference a built asset");
  const assetResponse = await fetch(`${rootUrl}${assetPath}`);
  if (!assetResponse.ok || (await assetResponse.arrayBuffer()).byteLength === 0) {
    throw new Error("Production asset was not served");
  }

  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const [raw] = await once(socket, "message");
  const decoded = decodeServerMessage(raw.toString());
  if (!decoded.success || decoded.data.type !== "welcome") {
    throw new Error("Production WebSocket did not provide a valid welcome baseline");
  }
  socket.close(1000, "production smoke complete");
  await once(socket, "close");
  console.log(`production smoke passed: HTTP HTML+asset and WebSocket welcome on port ${port}`);
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill();
  if (stderr.trim()) process.stderr.write(stderr);
}
