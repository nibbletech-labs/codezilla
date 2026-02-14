/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_TRANSCRIPT_WATCHER?: string;
  readonly VITE_THREAD_ACTIVITY_MODE?: "legacy" | "hybrid" | "marker";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
