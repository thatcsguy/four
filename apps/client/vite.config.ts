import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const port = Number.parseInt(env.VITE_PORT ?? "5173", 10);

  return {
    server: {
      port: Number.isSafeInteger(port) && port > 0 ? port : 5173,
      strictPort: true,
    },
  };
});
