//! Copland's HTTP API, the only way the daemon reaches it. Every call carries
//! a credential: the agent's own token, or a run's secret for what the run
//! does itself (claiming, keeping alive). The exception is the device flow the
//! box's setup uses to get those tokens in the first place (`device_start`,
//! `device_poll`). Shapes follow `src/domain/types.ts`.

use std::fmt;
use std::sync::Once;
use std::time::Duration;

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::json;

use crate::config::Secret;

#[derive(Debug, Clone, Deserialize)]
pub struct User {
    pub id: String,
    pub kind: String,
    pub handle: String,
}

/// What the credential may do, when it is a token (or a run's secret).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Access {
    /// "read" or "write".
    pub scope: String,
    pub via: String,
    pub run_id: Option<String>,
}

/// GET /api/me
#[derive(Debug, Clone, Deserialize)]
pub struct Me {
    pub user: User,
    /// Missing from a server older than COPL-53.
    #[serde(default)]
    pub access: Option<Access>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRef {
    pub id: String,
    pub key: String,
    pub title: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Actor {
    /// Missing from a server older than COPL-52; the handle is the fallback then.
    #[serde(default)]
    pub id: Option<String>,
    pub handle: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub id: String,
    pub kind: String,
    /// Every item has a task today; chat-style items without one may come later.
    pub task: Option<TaskRef>,
    pub actor: Actor,
    pub via: Option<String>,
    pub created_at: String,
    pub read_at: Option<String>,
}

/// GET /api/inbox: one page.
#[derive(Debug, Clone, Deserialize)]
pub struct Inbox {
    pub unread: u64,
    pub items: Vec<InboxItem>,
    pub next: Option<String>,
}

/// The parts of a task the daemon looks at.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub key: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    /// A run on it right now; only live claims are sent.
    #[serde(default)]
    pub claim: Option<Claim>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub run_id: String,
    /// "8f31".
    pub run: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    /// "8f31", how people see it.
    pub short: String,
    pub status: String,
    pub claims: Vec<String>,
}

/// POST /api/runs: the run and its secret, given once.
#[derive(Debug, Deserialize)]
pub struct StartedRun {
    pub run: Run,
    pub secret: Secret,
}

/// One task on the wired scene (`WiredTask` in `src/domain/types.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WiredTask {
    pub id: String,
    pub board_id: String,
    /// "COPL-12": the board's key, a dash, the task's number.
    pub key: String,
    pub title: String,
    /// The claimer when a run holds it, else the first of the owner's agents assigned.
    pub agent_id: String,
    /// doing: when the live claim was taken (none when no run holds it). done: when it was
    /// completed. Otherwise when the task last changed. ISO 8601, UTC.
    pub since: Option<String>,
    /// doing only: a run of the agent holds a live claim on it right now.
    #[serde(default)]
    pub live: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct WiredAgent {
    pub id: String,
    pub handle: String,
    pub name: String,
    #[serde(default)]
    pub paused: bool,
}

/// GET /api/wired: what the signed-in person's agents have on, by pole. A person's own read;
/// an agent's token is refused.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Wired {
    pub agents: Vec<WiredAgent>,
    pub todo: Vec<WiredTask>,
    /// Live claims first (oldest claim first), then active tasks no run holds.
    pub doing: Vec<WiredTask>,
    pub blocked: Vec<WiredTask>,
    /// Done within the window, newest first, capped by the server.
    pub done: Vec<WiredTask>,
    /// All of those done within the window.
    pub done_count: u32,
    pub done_window_hours: u32,
}

/// One board from GET /api/boards, the parts the box shows.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardRef {
    pub id: String,
    /// "COPL": what task keys start with.
    pub key: String,
    pub name: String,
    /// The person's private inbox board.
    #[serde(default)]
    pub is_inbox: bool,
}

/// GET /api/settings, the one setting the box follows.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct OwnSettings {
    pub theme: String,
}

/// DELETE /api/tokens/self: which token went.
#[derive(Debug, Clone, Deserialize)]
pub struct Revoked {
    pub revoked: String,
}

/// POST /api/device/start: a code for the person to approve in the browser (COPL-47).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStart {
    /// What this machine polls with. Not shown to anyone.
    pub device_code: String,
    /// What the person sees and checks in the browser.
    pub user_code: String,
    pub verify_url: String,
    /// Seconds between polls.
    pub interval: u64,
    /// Seconds until the code lapses.
    pub expires_in: u64,
}

/// One identity handed over by an approved device code, with its token (given once).
#[derive(Debug, Clone, Deserialize)]
pub struct DeviceIdentity {
    pub handle: String,
    pub token: Secret,
}

/// POST /api/device/poll.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum DevicePoll {
    /// `slow_down` asks for a longer interval (polled too fast), as in RFC 8628.
    Pending {
        #[serde(default)]
        slow_down: bool,
    },
    Denied,
    Expired,
    /// The tokens are delivered on this answer only; a later poll will not repeat them.
    Approved {
        url: String,
        /// Absent when the box asked for named agents: it already has its owner's token.
        #[serde(default)]
        owner: Option<DeviceIdentity>,
        #[serde(default)]
        agents: Vec<DeviceIdentity>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ending {
    Completed,
    Failed,
    Cancelled,
}

impl Ending {
    pub fn as_str(self) -> &'static str {
        match self {
            Ending::Completed => "completed",
            Ending::Failed => "failed",
            Ending::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug)]
pub enum ApiError {
    /// The server answered, and said no. `message` is its own words.
    Status {
        status: u16,
        /// Why, when the server gave a reason a program can act on (a claim's "claimed").
        code: Option<String>,
        message: String,
    },
    /// No usable answer: the network, a timeout, or a body that was not what we expected.
    Transport(String),
}

impl ApiError {
    pub fn status(&self) -> Option<u16> {
        match self {
            ApiError::Status { status, .. } => Some(*status),
            ApiError::Transport(_) => None,
        }
    }
    pub fn code(&self) -> Option<&str> {
        match self {
            ApiError::Status { code, .. } => code.as_deref(),
            ApiError::Transport(_) => None,
        }
    }
    /// A refusal that asking again will not change (4xx, except rate limiting).
    pub fn is_refusal(&self) -> bool {
        matches!(self.status(), Some(s) if (400..500).contains(&s) && s != 429)
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ApiError::Status { status, message, .. } => write!(f, "{status}: {message}"),
            ApiError::Transport(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for ApiError {}

pub type ApiResult<T> = Result<T, ApiError>;

#[derive(Deserialize)]
struct ErrorBody {
    code: Option<String>,
    message: Option<String>,
    error: Option<String>,
}

/// An error and its causes, "error sending request: connection refused", without repeats.
pub(crate) fn chain(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut cause = e.source();
    while let Some(c) = cause {
        let s = c.to_string();
        if !out.contains(&s) {
            out.push_str(": ");
            out.push_str(&s);
        }
        cause = c.source();
    }
    out
}

static TLS: Once = Once::new();

/// reqwest is built without a crypto provider of its own (no aws-lc, no cmake); ring is it.
pub(crate) fn install_tls() {
    TLS.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// One instance's API.
#[derive(Clone)]
pub struct Api {
    http: reqwest::Client,
    base: String,
}

impl Api {
    pub fn new(base: &str) -> anyhow::Result<Self> {
        install_tls();
        let http = reqwest::Client::builder()
            .user_agent(concat!("copland-daemon/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .build()?;
        Ok(Self {
            http,
            base: base.trim_end_matches('/').to_string(),
        })
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    async fn send<T: DeserializeOwned>(&self, req: reqwest::RequestBuilder, cred: &Secret) -> ApiResult<T> {
        self.send_as(req.bearer_auth(cred.expose())).await
    }

    async fn send_as<T: DeserializeOwned>(&self, req: reqwest::RequestBuilder) -> ApiResult<T> {
        let res = req
            .send()
            .await
            /* reqwest's errors carry the URL, never headers, so they are safe to show. */
            .map_err(|e| ApiError::Transport(chain(&e.without_url())))?;
        let status = res.status();
        if status.is_success() {
            return res
                .json::<T>()
                .await
                .map_err(|e| ApiError::Transport(format!("unexpected answer: {e}")));
        }
        let text = res.text().await.unwrap_or_default();
        let body = serde_json::from_str::<ErrorBody>(&text).ok();
        let code = body.as_ref().and_then(|b| b.code.clone());
        let message = body
            .and_then(|b| b.message.or(b.error))
            .unwrap_or_else(|| text.chars().take(200).collect());
        Err(ApiError::Status {
            status: status.as_u16(),
            code,
            message,
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    /// Ask for a device code: the one call made with no credential, since getting one is what it is for.
    /// `agents` (handles or ids) are the ones the approval page ticks to begin with; empty leaves it
    /// to the page (every agent that isn't paused). A server older than COPL-55 ignores it.
    pub async fn device_start(&self, client: &str, host: &str, agents: &[String]) -> ApiResult<DeviceStart> {
        let mut body = json!({ "client": client, "host": host });
        if !agents.is_empty() {
            body["agents"] = json!(agents);
        }
        self.send_as(self.http.post(self.url("/api/device/start")).json(&body))
            .await
    }

    /// Whether the person has approved the code yet. The device code is the credential here.
    pub async fn device_poll(&self, device_code: &str) -> ApiResult<DevicePoll> {
        let body = json!({ "deviceCode": device_code });
        self.send_as(self.http.post(self.url("/api/device/poll")).json(&body))
            .await
    }

    pub async fn me(&self, cred: &Secret) -> ApiResult<Me> {
        self.send(self.http.get(self.url("/api/me")), cred).await
    }

    /// The token's person's agents' work, by pole (what the box draws). Refused for an agent's token.
    pub async fn wired(&self, cred: &Secret) -> ApiResult<Wired> {
        self.send(self.http.get(self.url("/api/wired")), cred).await
    }

    /// The boards the token's principal is on (the box's boards filter).
    pub async fn boards(&self, cred: &Secret) -> ApiResult<Vec<BoardRef>> {
        self.send(self.http.get(self.url("/api/boards")), cred).await
    }

    /// The token's person's settings, of which the box reads the theme. Refused for an agent's token.
    pub async fn settings(&self, cred: &Secret) -> ApiResult<OwnSettings> {
        self.send(self.http.get(self.url("/api/settings")), cred).await
    }

    /// Revoke the token this is called with, and nothing else (signing the box out).
    pub async fn revoke_self(&self, token: &Secret) -> ApiResult<Revoked> {
        self.send(self.http.delete(self.url("/api/tokens/self")), token).await
    }

    /// A GET with no credential at all, for a public JSON API (the box's release check).
    pub async fn get_public<T: DeserializeOwned>(&self, path: &str) -> ApiResult<T> {
        self.send_as(
            self.http
                .get(self.url(path))
                .header("accept", "application/vnd.github+json"),
        )
        .await
    }

    /// One page of unread items, newest first.
    pub async fn inbox_unread(&self, cred: &Secret, limit: u32, cursor: Option<&str>) -> ApiResult<Inbox> {
        let mut query = vec![("unread", "true".to_string()), ("limit", limit.to_string())];
        if let Some(c) = cursor {
            query.push(("cursor", c.to_string()));
        }
        self.send(self.http.get(self.url("/api/inbox")).query(&query), cred)
            .await
    }

    /// A task by id or key.
    pub async fn task(&self, cred: &Secret, id: &str) -> ApiResult<Task> {
        self.send(self.http.get(self.url(&format!("/api/tasks/{id}"))), cred)
            .await
    }

    /// Start a run with the agent's own token.
    pub async fn start_run(&self, token: &Secret, client: &str) -> ApiResult<StartedRun> {
        self.send(
            self.http.post(self.url("/api/runs")).json(&json!({ "client": client })),
            token,
        )
        .await
    }

    /// Read the run. Called with the run's secret, it is also the run's keepalive.
    pub async fn run(&self, cred: &Secret, id: &str) -> ApiResult<Run> {
        self.send(self.http.get(self.url(&format!("/api/runs/{id}"))), cred)
            .await
    }

    /// Finish the run. Works with the agent's token even after the run's secret has died; a run already over is answered as it is.
    pub async fn finish_run(&self, token: &Secret, id: &str, ending: Ending) -> ApiResult<Run> {
        let req = self
            .http
            .post(self.url(&format!("/api/runs/{id}/finish")))
            .json(&json!({ "status": ending.as_str() }));
        self.send(req, token).await
    }

    /// Claim a task for the run whose secret this is.
    pub async fn claim(&self, run_secret: &Secret, task_id: &str) -> ApiResult<Task> {
        self.send(
            self.http.post(self.url(&format!("/api/tasks/{task_id}/claim"))),
            run_secret,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_device_flow_answers() {
        let s: DeviceStart = serde_json::from_str(
            r#"{"deviceCode":"d1","userCode":"WXYZ-1234","verifyUrl":"http://x/device","interval":5,"expiresIn":600}"#,
        )
        .unwrap();
        assert_eq!((s.user_code.as_str(), s.interval, s.expires_in), ("WXYZ-1234", 5, 600));
        let p: DevicePoll = serde_json::from_str(r#"{"status":"pending"}"#).unwrap();
        assert!(matches!(p, DevicePoll::Pending { slow_down: false }));
        let p: DevicePoll = serde_json::from_str(r#"{"status":"pending","slow_down":true}"#).unwrap();
        assert!(matches!(p, DevicePoll::Pending { slow_down: true }));
        let p: DevicePoll = serde_json::from_str(r#"{"status":"expired"}"#).unwrap();
        assert!(matches!(p, DevicePoll::Expired));
        let p: DevicePoll = serde_json::from_str(
            r#"{"status":"approved","url":"http://x","owner":{"handle":"me","token":"cpl_o"},"agents":[{"handle":"me/dev","token":"cpl_a"}]}"#,
        )
        .unwrap();
        let DevicePoll::Approved { url, owner, agents } = p else {
            panic!("not approved")
        };
        assert_eq!((url.as_str(), owner.unwrap().handle.as_str()), ("http://x", "me"));
        assert_eq!(agents[0].token.expose(), "cpl_a");
        assert!(!format!("{:?}", agents[0]).contains("cpl_a"));
        assert!(serde_json::from_str::<DevicePoll>(r#"{"status":"maybe"}"#).is_err());
    }
}
