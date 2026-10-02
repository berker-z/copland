//! Copland's HTTP API, the only way the daemon reaches it. Every call carries
//! a credential: the agent's own token, or a run's secret for what the run
//! does itself (claiming, keeping alive). Shapes follow `src/domain/types.ts`.

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

/// GET /api/me
#[derive(Debug, Clone, Deserialize)]
pub struct Me {
    pub user: User,
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
    Status { status: u16, message: String },
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
    /// A refusal that asking again will not change (4xx, except rate limiting).
    pub fn is_refusal(&self) -> bool {
        matches!(self.status(), Some(s) if (400..500).contains(&s) && s != 429)
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ApiError::Status { status, message } => write!(f, "{status}: {message}"),
            ApiError::Transport(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for ApiError {}

pub type ApiResult<T> = Result<T, ApiError>;

#[derive(Deserialize)]
struct ErrorBody {
    message: Option<String>,
    error: Option<String>,
}

static TLS: Once = Once::new();

/// One instance's API.
#[derive(Clone)]
pub struct Api {
    http: reqwest::Client,
    base: String,
}

impl Api {
    pub fn new(base: &str) -> anyhow::Result<Self> {
        /* reqwest is built without a crypto provider of its own (no aws-lc, no cmake); ring is it. */
        TLS.call_once(|| {
            let _ = rustls::crypto::ring::default_provider().install_default();
        });
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
        let res = req
            .bearer_auth(cred.expose())
            .send()
            .await
            /* reqwest's errors carry the URL, never headers, so they are safe to show. */
            .map_err(|e| ApiError::Transport(e.without_url().to_string()))?;
        let status = res.status();
        if status.is_success() {
            return res
                .json::<T>()
                .await
                .map_err(|e| ApiError::Transport(format!("unexpected answer: {e}")));
        }
        let text = res.text().await.unwrap_or_default();
        let message = serde_json::from_str::<ErrorBody>(&text)
            .ok()
            .and_then(|b| b.message.or(b.error))
            .unwrap_or_else(|| text.chars().take(200).collect());
        Err(ApiError::Status {
            status: status.as_u16(),
            message,
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    pub async fn me(&self, cred: &Secret) -> ApiResult<Me> {
        self.send(self.http.get(self.url("/api/me")), cred).await
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
