// Close protection - currently a no-op.
// PTY cleanup is handled by Rust's on_window_event(Destroyed) handler.
// TODO: Add confirmation dialog for running processes.
export function useCloseProtection() {}
