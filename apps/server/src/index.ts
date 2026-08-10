import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { configuredPort } from "./config.js";
import { GameServer } from "./game-server.js";

export * from "./config.js";
export * from "./game-server.js";

const isMainModule = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const productionClientDirectory = process.env.NODE_ENV === "production"
    ? fileURLToPath(new URL("../../client/dist", import.meta.url))
    : undefined;
  const server = new GameServer({
    port: configuredPort(),
    host: "0.0.0.0",
    ...(productionClientDirectory === undefined ? {} : { productionClientDirectory }),
  });
  const address = await server.start();
  console.log(`Four authoritative server listening on http://${address.host}:${address.port}`);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server.stop();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
