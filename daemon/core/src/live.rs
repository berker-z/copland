//! Copland's live updates, the daemon's side (COPL-62): one WebSocket to
//! `/api/live` per credential, so a new assignment wakes the agent at once
//! instead of at its next poll.
//!
//! The socket carries topic names only ("inbox", "board", …), never data: on
//! one, the caller polls the HTTP API as usual, so access checks and what is
//! read stay the routes'. A burst of topics becomes one wake (`Coalesce`). A
//! dropped socket is retried with backoff and jitter (`Backoff`), and while
//! it is down the caller's poll is all there is, so nothing waits on it.
//!
//! It authenticates with the token as a Bearer header on the upgrade, like
//! any other request; the token never goes in the URL. The server puts the
//! socket in the token's principal's own hub (`src/worker/live.ts`), so an
//! agent's token hears only what is sent to the agent.
//!
//! The client is this file: a WebSocket is a short handshake and a small
//! frame format, and doing it here over reqwest's upgraded connection keeps
//! the daemon on the crates it already has (no tungstenite). It speaks only
//! what Copland's hub sends: text messages, pings, close.

use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use ring::rand::SecureRandom;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

use crate::config::Secret;

/// How often to poll anyway while the socket is up: a fallback for a message that never came
/// (the hub keeps nothing, so one sent during a reconnect is gone). While it is down, the
/// configured `poll_interval` applies.
pub const FALLBACK_POLL: Duration = Duration::from_secs(300);
/// Topics within this of the first become one wake, as the browser does.
pub const COALESCE: Duration = Duration::from_millis(300);
/// How often the socket says "ping" (the hub's auto-response answers "pong" without waking).
pub const PING_EVERY: Duration = Duration::from_secs(30);
/// Nothing heard for this long, not even a pong: the connection is dead, whatever TCP thinks.
pub const SILENCE: Duration = Duration::from_secs(75);
/// The longest wait between attempts after a network failure.
pub const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// After the server refused the socket (a token it won't take, a server without COPL-62).
pub const REFUSED_BACKOFF: Duration = Duration::from_secs(300);
/// A socket that stayed open this long was a good one: the next failure backs off from the start.
pub const STABLE: Duration = Duration::from_secs(30);
/// The handshake, connect to 101.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
/// Nothing Copland sends is near this; a larger frame means something else is talking.
const MAX_MESSAGE: usize = 64 * 1024;

/// The socket's state, as the daemon publishes it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Link {
    /// Not tried yet.
    #[default]
    Connecting,
    /// Open: changes arrive as they happen, and the poll is only a fallback.
    Connected,
    /// Down, and being retried; until then the poll is all there is.
    Reconnecting,
}

/// What the socket heard, after coalescing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Heard {
    /// These topics changed.
    Topics(BTreeSet<String>),
    /// The socket is back after being down: whatever changed meanwhile was never sent.
    Resync,
}

/// Delays between attempts: 1s doubling to `MAX_BACKOFF`, each scaled into its upper half at
/// random, so many daemons that lost the same server don't come back in step. A refusal
/// waits `REFUSED_BACKOFF`, also jittered: asking again soon won't change the answer.
#[derive(Debug, Default)]
pub struct Backoff {
    attempts: u32,
}

impl Backoff {
    /// The wait before the next attempt; `r` is uniform in [0, 1).
    pub fn next(&mut self, refused: bool, r: f64) -> Duration {
        let base = if refused {
            REFUSED_BACKOFF
        } else {
            Duration::from_secs(1u64 << self.attempts.min(16)).min(MAX_BACKOFF)
        };
        self.attempts = self.attempts.saturating_add(1);
        base.mul_f64(0.5 + r.clamp(0.0, 1.0) / 2.0)
    }

    /// Connected: the next failure starts from the bottom again.
    pub fn reset(&mut self) {
        self.attempts = 0;
    }
}

/// Topics gathered until `COALESCE` after the first, then handed over at once.
#[derive(Debug, Default)]
pub struct Coalesce {
    topics: BTreeSet<String>,
    due: Option<Instant>,
}

impl Coalesce {
    /// A message's topics arrived at `now` (only those the caller wants).
    pub fn add(&mut self, topics: impl IntoIterator<Item = String>, now: Instant) {
        let before = self.topics.len();
        self.topics.extend(topics);
        if self.topics.len() > before && self.due.is_none() {
            self.due = Some(now + COALESCE);
        }
    }

    /// When the gathered topics are due, if any are.
    pub fn due(&self) -> Option<Instant> {
        self.due
    }

    /// The gathered topics, if they are due at `now`.
    pub fn take(&mut self, now: Instant) -> Option<BTreeSet<String>> {
        match self.due {
            Some(due) if now >= due => {
                self.due = None;
                Some(std::mem::take(&mut self.topics))
            }
            _ => None,
        }
    }
}

/// The topics of one hub message, `{"topics":[…],"tab":…}`, or none for anything else.
pub fn topics_of(message: &str) -> Vec<String> {
    #[derive(serde::Deserialize)]
    struct Event {
        topics: Vec<String>,
    }
    serde_json::from_str::<Event>(message)
        .map(|e| e.topics)
        .unwrap_or_default()
}

/// Keep a socket to `base`'s `/api/live` open with `token` for as long as the future lives
/// (drop or abort it to stop), reporting its state to `on_link` and, for the topics `wanted`
/// takes, each coalesced burst (or a resync after a reconnect) to `on_heard`. Never returns.
pub async fn listen(
    base: &str,
    token: &Secret,
    wanted: impl Fn(&str) -> bool,
    on_link: impl Fn(Link),
    on_heard: impl Fn(Heard),
) {
    let rng = ring::rand::SystemRandom::new();
    let mut backoff = Backoff::default();
    let mut ever = false;
    /* The same failure every attempt (server down) is logged once, until it changes. */
    let mut said: Option<String> = None;
    let http = loop {
        match client() {
            Ok(http) => break http,
            Err(e) => {
                tracing::warn!("live updates unavailable, polling instead: {e}");
                on_link(Link::Reconnecting);
                tokio::time::sleep(REFUSED_BACKOFF).await;
            }
        }
    };
    loop {
        match connect(&http, base, token, &rng).await {
            Ok(socket) => {
                if said.take().is_some() || ever {
                    tracing::info!("live updates connected again");
                } else {
                    tracing::debug!("live updates connected");
                }
                on_link(Link::Connected);
                if ever {
                    on_heard(Heard::Resync);
                }
                ever = true;
                let opened = Instant::now();
                let why = socket.run(&rng, &wanted, &on_heard).await;
                /* One that opens and drops at once keeps backing off, so it never spins. */
                if opened.elapsed() >= STABLE {
                    backoff.reset();
                }
                tracing::info!("live updates dropped ({why:#}); polling until they are back");
                on_link(Link::Reconnecting);
                let wait = backoff.next(false, random(&rng));
                tokio::time::sleep(wait).await;
            }
            Err(e) => {
                let refused = matches!(e, Failure::Refused(..));
                let message = e.to_string();
                if said.as_deref() != Some(message.as_str()) {
                    tracing::info!("live updates unavailable, polling instead: {message}");
                } else {
                    tracing::debug!("live updates unavailable: {message}");
                }
                said = Some(message);
                on_link(Link::Reconnecting);
                tokio::time::sleep(backoff.next(refused, random(&rng))).await;
            }
        }
    }
}

fn random(rng: &ring::rand::SystemRandom) -> f64 {
    let mut b = [0u8; 4];
    let _ = rng.fill(&mut b);
    u32::from_le_bytes(b) as f64 / (u32::MAX as f64 + 1.0)
}

#[derive(Debug)]
enum Failure {
    /// The server answered and said no: the status and its words.
    Refused(u16, String),
    /// No answer, or not a WebSocket.
    Network(String),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::Refused(status, message) => write!(f, "refused, {status}: {message}"),
            Failure::Network(e) => f.write_str(e),
        }
    }
}

/// The URL reqwest is asked for: the instance's own, http(s); the upgrade makes it a WebSocket.
fn live_url(base: &str) -> String {
    format!("{}/api/live", base.trim_end_matches('/'))
}

/// The client every attempt uses (built once: building one reads the system's certificates).
fn client() -> Result<reqwest::Client, Failure> {
    crate::api::install_tls();
    /* HTTP/1.1 only: a WebSocket upgrade is an HTTP/1.1 thing, and ALPN would otherwise pick h2. */
    reqwest::Client::builder()
        .user_agent(concat!("copland-daemon/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .http1_only()
        .build()
        .map_err(|e| Failure::Network(crate::api::chain(&e)))
}

async fn connect(
    http: &reqwest::Client,
    base: &str,
    token: &Secret,
    rng: &ring::rand::SystemRandom,
) -> Result<Socket, Failure> {
    let mut nonce = [0u8; 16];
    rng.fill(&mut nonce)
        .map_err(|_| Failure::Network("no randomness".into()))?;
    let key = base64(&nonce);
    let request = http
        .get(live_url(base))
        .bearer_auth(token.expose())
        .header("connection", "Upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", &key);
    let response = tokio::time::timeout(HANDSHAKE_TIMEOUT, request.send())
        .await
        .map_err(|_| Failure::Network("the handshake timed out".into()))?
        /* reqwest's errors carry the URL, never headers. */
        .map_err(|e| Failure::Network(crate::api::chain(&e.without_url())))?;
    let status = response.status().as_u16();
    if status != 101 {
        let text = response.text().await.unwrap_or_default();
        let message = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("error")
                    .or(v.get("message"))
                    .and_then(|m| m.as_str().map(String::from))
            })
            .unwrap_or_else(|| text.chars().take(200).collect());
        return Err(if (400..500).contains(&status) && status != 429 {
            Failure::Refused(status, message)
        } else {
            Failure::Network(format!("{status}: {message}"))
        });
    }
    let accept = response
        .headers()
        .get("sec-websocket-accept")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    if accept != accept_for(&key) {
        return Err(Failure::Network("the server's handshake didn't match".into()));
    }
    let upgraded = response
        .upgrade()
        .await
        .map_err(|e| Failure::Network(crate::api::chain(&e)))?;
    Ok(Socket { io: Box::new(upgraded) })
}

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

struct Socket {
    io: Box<dyn Io>,
}

impl Socket {
    /// Read until the socket ends, pinging on the way. Returns why it ended.
    async fn run(
        self,
        rng: &ring::rand::SystemRandom,
        wanted: &impl Fn(&str) -> bool,
        on_heard: &impl Fn(Heard),
    ) -> anyhow::Error {
        let (read, mut write) = tokio::io::split(self.io);
        let mut frames = Frames::new(BufReader::new(read));
        let mut coalesce = Coalesce::default();
        let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + PING_EVERY, PING_EVERY);
        let mut heard_at = Instant::now();
        loop {
            let flush = coalesce.due().map(tokio::time::Instant::from_std);
            tokio::select! {
                frame = frames.next() => {
                    heard_at = Instant::now();
                    match frame {
                        Ok(Frame::Text(text)) => {
                            let topics = topics_of(&text).into_iter().filter(|t| wanted(t));
                            coalesce.add(topics, heard_at);
                        }
                        Ok(Frame::Ping(payload)) => {
                            if let Err(e) = send(&mut write, OP_PONG, &payload, rng).await {
                                return e;
                            }
                        }
                        Ok(Frame::Close(code)) => {
                            let _ = send(&mut write, OP_CLOSE, &code.unwrap_or(1000).to_be_bytes(), rng).await;
                            return anyhow!("closed by the server{}", code.map(|c| format!(", {c}")).unwrap_or_default());
                        }
                        Ok(Frame::Other) => {}
                        Err(e) => return e,
                    }
                }
                _ = async { tokio::time::sleep_until(flush.expect("guarded")).await }, if flush.is_some() => {
                    if let Some(topics) = coalesce.take(Instant::now()) {
                        on_heard(Heard::Topics(topics));
                    }
                }
                _ = ping.tick() => {
                    if heard_at.elapsed() > SILENCE {
                        return anyhow!("nothing heard for {}s", SILENCE.as_secs());
                    }
                    if let Err(e) = send(&mut write, OP_TEXT, b"ping", rng).await {
                        return e;
                    }
                }
            }
        }
    }
}

const OP_CONTINUATION: u8 = 0x0;
const OP_TEXT: u8 = 0x1;
const OP_BINARY: u8 = 0x2;
const OP_CLOSE: u8 = 0x8;
const OP_PING: u8 = 0x9;
const OP_PONG: u8 = 0xA;

#[derive(Debug, PartialEq, Eq)]
enum Frame {
    Text(String),
    Ping(Vec<u8>),
    /// With its status code, when it gave one.
    Close(Option<u16>),
    /// A pong, or a binary message: nothing to act on.
    Other,
}

/// Messages from the server, reassembling fragmented ones.
struct Frames<R> {
    read: R,
    /// A message being reassembled: its opcode and what has come so far.
    partial: Option<(u8, Vec<u8>)>,
}

impl<R: AsyncRead + Unpin> Frames<R> {
    fn new(read: R) -> Self {
        Self { read, partial: None }
    }

    async fn next(&mut self) -> Result<Frame> {
        loop {
            let mut head = [0u8; 2];
            self.read.read_exact(&mut head).await.context("reading")?;
            let fin = head[0] & 0x80 != 0;
            let op = head[0] & 0x0F;
            if head[0] & 0x70 != 0 {
                bail!("a frame with reserved bits set");
            }
            let masked = head[1] & 0x80 != 0;
            let len = match head[1] & 0x7F {
                126 => self.read.read_u16().await? as u64,
                127 => self.read.read_u64().await?,
                n => n as u64,
            };
            if len > MAX_MESSAGE as u64 {
                bail!("a {len}-byte frame, more than a live update ever is");
            }
            let mut mask = [0u8; 4];
            if masked {
                self.read.read_exact(&mut mask).await?;
            }
            let mut payload = vec![0u8; len as usize];
            self.read.read_exact(&mut payload).await?;
            if masked {
                apply_mask(&mut payload, mask);
            }
            match op {
                OP_PING => return Ok(Frame::Ping(payload)),
                OP_PONG => return Ok(Frame::Other),
                OP_CLOSE => {
                    let code = (payload.len() >= 2).then(|| u16::from_be_bytes([payload[0], payload[1]]));
                    return Ok(Frame::Close(code));
                }
                OP_TEXT | OP_BINARY | OP_CONTINUATION => {
                    let (op, mut data) = match (op, self.partial.take()) {
                        (OP_CONTINUATION, Some(p)) => p,
                        (OP_CONTINUATION, None) => bail!("a continuation with nothing to continue"),
                        (_, Some(_)) => bail!("a new message inside a fragmented one"),
                        (op, None) => (op, Vec::new()),
                    };
                    data.extend_from_slice(&payload);
                    if data.len() > MAX_MESSAGE {
                        bail!("a message longer than a live update ever is");
                    }
                    if !fin {
                        self.partial = Some((op, data));
                        continue;
                    }
                    return Ok(if op == OP_TEXT {
                        Frame::Text(String::from_utf8(data).context("a text message that isn't UTF-8")?)
                    } else {
                        Frame::Other
                    });
                }
                _ => bail!("an unknown opcode {op}"),
            }
        }
    }
}

fn apply_mask(data: &mut [u8], mask: [u8; 4]) {
    for (i, b) in data.iter_mut().enumerate() {
        *b ^= mask[i % 4];
    }
}

/// One whole frame as a client sends it: final, masked.
fn encode(op: u8, payload: &[u8], mask: [u8; 4]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 14);
    out.push(0x80 | op);
    match payload.len() {
        n if n < 126 => out.push(0x80 | n as u8),
        n if n <= u16::MAX as usize => {
            out.push(0x80 | 126);
            out.extend_from_slice(&(n as u16).to_be_bytes());
        }
        n => {
            out.push(0x80 | 127);
            out.extend_from_slice(&(n as u64).to_be_bytes());
        }
    }
    out.extend_from_slice(&mask);
    let start = out.len();
    out.extend_from_slice(payload);
    apply_mask(&mut out[start..], mask);
    out
}

async fn send<W: AsyncWrite + Unpin>(
    write: &mut W,
    op: u8,
    payload: &[u8],
    rng: &ring::rand::SystemRandom,
) -> Result<(), anyhow::Error> {
    let mut mask = [0u8; 4];
    let _ = rng.fill(&mut mask);
    write.write_all(&encode(op, payload, mask)).await.context("writing")?;
    write.flush().await.context("writing")?;
    Ok(())
}

/// What the server must answer a handshake `key` with (RFC 6455 §4.2.2).
fn accept_for(key: &str) -> String {
    let mut input = key.as_bytes().to_vec();
    input.extend_from_slice(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    base64(ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, &input).as_ref())
}

/// Standard base64 with padding: for the handshake's two short values only.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n =
            (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_handshake_matches_the_rfc() {
        /* RFC 6455 §1.3's example. */
        assert_eq!(accept_for("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
        assert_eq!(base64(b"the sample nonce"), "dGhlIHNhbXBsZSBub25jZQ==");
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
    }

    #[test]
    fn backoff_doubles_to_a_ceiling_with_jitter_and_resets() {
        let mut b = Backoff::default();
        let lows: Vec<u64> = (0..8).map(|_| b.next(false, 0.0).as_millis() as u64).collect();
        assert_eq!(lows, [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
        assert_eq!(b.next(false, 0.999_999), MAX_BACKOFF.mul_f64(0.5 + 0.999_999 / 2.0));
        /* Never zero, never past the ceiling, however many attempts. */
        for _ in 0..100 {
            let d = b.next(false, 0.5);
            assert!(d >= Duration::from_millis(500) && d <= MAX_BACKOFF);
        }
        b.reset();
        assert_eq!(b.next(false, 1.0), Duration::from_secs(1));
        /* A refusal waits long whatever the count. */
        b.reset();
        assert_eq!(b.next(true, 0.0), REFUSED_BACKOFF / 2);
        assert_eq!(b.next(true, 1.0), REFUSED_BACKOFF);
    }

    #[test]
    fn a_burst_of_topics_is_one_wake() {
        let t0 = Instant::now();
        let mut c = Coalesce::default();
        assert_eq!(c.due(), None);
        assert_eq!(c.take(t0), None);
        c.add(["board".to_string()], t0);
        c.add(
            ["inbox".to_string(), "board".to_string()],
            t0 + Duration::from_millis(200),
        );
        /* The window runs from the first, not the last. */
        assert_eq!(c.due(), Some(t0 + COALESCE));
        assert_eq!(c.take(t0 + Duration::from_millis(299)), None);
        let got = c.take(t0 + COALESCE).unwrap();
        assert_eq!(got.into_iter().collect::<Vec<_>>(), ["board", "inbox"]);
        assert_eq!(c.due(), None);
        /* Nothing wanted: nothing scheduled. */
        c.add(std::iter::empty(), t0);
        assert_eq!(c.due(), None);
    }

    #[test]
    fn reads_the_hubs_messages() {
        assert_eq!(
            topics_of(r#"{"topics":["inbox","board"],"tab":null}"#),
            ["inbox", "board"]
        );
        assert!(topics_of("pong").is_empty());
        assert!(topics_of(r#"{"tab":"x"}"#).is_empty());
    }

    #[tokio::test]
    async fn frames_round_trip_including_fragments_and_control() {
        let mask = [1, 2, 3, 4];
        let mut wire = Vec::new();
        /* A masked text frame, as a client would send. */
        wire.extend(encode(OP_TEXT, br#"{"topics":["inbox"]}"#, mask));
        /* Server frames are unmasked; a fragmented text with a ping in the middle. */
        wire.extend([0x01, 3]);
        wire.extend(b"abc");
        wire.extend([0x89, 2, b'h', b'i']);
        wire.extend([0x80, 3]);
        wire.extend(b"def");
        /* A 200-byte message takes the 16-bit length. */
        let long = "x".repeat(200);
        wire.extend(encode(OP_TEXT, long.as_bytes(), mask));
        wire.extend([0x8A, 0]);
        wire.extend([0x88, 2, 0x0F, 0xA1]);
        let mut f = Frames::new(&wire[..]);
        assert_eq!(f.next().await.unwrap(), Frame::Text(r#"{"topics":["inbox"]}"#.into()));
        assert_eq!(f.next().await.unwrap(), Frame::Ping(b"hi".to_vec()));
        assert_eq!(f.next().await.unwrap(), Frame::Text("abcdef".into()));
        assert_eq!(f.next().await.unwrap(), Frame::Text(long));
        assert_eq!(f.next().await.unwrap(), Frame::Other);
        assert_eq!(f.next().await.unwrap(), Frame::Close(Some(4001)));
        assert!(f.next().await.is_err());
    }

    #[tokio::test]
    async fn refuses_what_copland_never_sends() {
        let mut big = vec![0x81, 127];
        big.extend((1u64 << 32).to_be_bytes());
        assert!(Frames::new(&big[..]).next().await.is_err());
        assert!(Frames::new(&[0x80u8, 1, b'x'][..]).next().await.is_err());
        assert!(Frames::new(&[0xC1u8, 0][..]).next().await.is_err());
    }

    #[test]
    fn the_url_carries_no_credential() {
        assert_eq!(live_url("https://c.example/"), "https://c.example/api/live");
    }
}
