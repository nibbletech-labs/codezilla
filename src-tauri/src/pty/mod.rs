pub mod session;

use serde::Serialize;
use session::PtySession;
use std::collections::HashMap;
use tauri::ipc::Channel;

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PtyActivitySource {
    Output,
    Progress,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum PtyEvent {
    Output { data: Vec<u8> },
    Activity {
        active: bool,
        source: PtyActivitySource,
    },
    CommandStart,
    CommandEnd { exit_code: Option<i32> },
    Exit { code: Option<i32> },
}

pub struct PtyManager {
    sessions: HashMap<String, PtySession>,
}

impl PtyManager {
    pub fn new() -> Self {
        PtyManager {
            sessions: HashMap::new(),
        }
    }

    pub fn reap_dead(&mut self) {
        self.sessions.retain(|_, session| session.is_alive());
    }

    pub fn spawn(
        &mut self,
        session_id: String,
        rows: u16,
        cols: u16,
        channel: Channel<PtyEvent>,
        cwd: Option<String>,
        command: Option<String>,
        activity_mode: Option<String>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let session = PtySession::spawn(rows, cols, channel, cwd, command, activity_mode)?;
        self.sessions.insert(session_id, session);
        Ok(())
    }

    pub fn write(&self, session_id: &str, data: &str) -> Result<(), Box<dyn std::error::Error>> {
        let session = self.sessions.get(session_id).ok_or("Session not found")?;
        session.write(data)
    }

    pub fn resize(
        &self,
        session_id: &str,
        rows: u16,
        cols: u16,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let session = self.sessions.get(session_id).ok_or("Session not found")?;
        session.resize(rows, cols)
    }

    pub fn kill(&mut self, session_id: &str) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(mut session) = self.sessions.remove(session_id) {
            session.kill()?;
        }
        Ok(())
    }

    /// Count sessions that are actively processing (not just alive and idle).
    /// Used for quit protection so idle sessions don't block quit.
    pub fn busy_session_count(&self) -> usize {
        self.sessions.values().filter(|s| s.is_busy()).count()
    }

    pub fn kill_all(&mut self) {
        let ids: Vec<String> = self.sessions.keys().cloned().collect();
        for id in ids {
            let _ = self.kill(&id);
        }
    }
}
