import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // Ignore src-tauri (Rust), and worktree checkouts + .git so that creating a
      // git worktree under .claude/worktrees/ doesn't trigger a full Vite reload
      // that wipes terminal state under `tauri dev`.
      ignored: ["**/src-tauri/**", "**/.claude/worktrees/**", "**/.git/**"],
    },
  },
});
