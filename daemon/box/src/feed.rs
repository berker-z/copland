//! The owner's view: `GET /api/wired` with the person's own token, every
//! fifteen seconds and soon after any of this daemon's runs starts or ends,
//! published as a `watch` value the window draws. It runs on the daemon's
//! Tokio runtime. The route is a person's own read, so an agent's token is
//! refused; that is said once and polling stops.

use std::time::{Duration, SystemTime};

use copland_daemon_core::DaemonState;
use copland_daemon_core::Phase;
use copland_daemon_core::api::{Api, Wired};
use copland_daemon_core::config::Owner;
use tokio::sync::watch;

/// How often it reads when nothing happens here.
pub const EVERY: Duration = Duration::from_secs(15);
/// After a run starts or ends, a moment for its claim or its last moves to land before reading.
const SETTLE: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Default)]
pub struct Feed {
    /// The instance it reads, for links.
    pub url: String,
    /// The last good read, and when (wall clock) it was taken.
    pub wired: Option<(Wired, SystemTime)>,
    /// What went wrong with the last read, cleared by a good one.
    pub error: Option<String>,
    /// The token can't be used for this at all; nothing more will be read.
    pub refused: bool,
}

/// Which run each agent is on: a change means a run started or ended.
fn runs(st: &DaemonState) -> Vec<Option<String>> {
    st.agents
        .iter()
        .map(|a| match &a.phase {
            Phase::Running { run, .. } => Some(run.clone()),
            _ => None,
        })
        .collect()
}

/// Resolves once some agent's run has started or ended (never, once the daemon is gone).
async fn run_changed(daemon: &mut watch::Receiver<DaemonState>, seen: &mut Vec<Option<String>>) {
    loop {
        if daemon.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
        let now = runs(&daemon.borrow_and_update());
        if &now != seen {
            *seen = now;
            return;
        }
    }
}

pub async fn run(owner: Owner, tx: watch::Sender<Feed>, mut daemon: watch::Receiver<DaemonState>) {
    let refuse = |why: String| {
        tracing::error!("{why}");
        tx.send_modify(|f| {
            f.error = Some(why);
            f.refused = true;
        });
    };
    let api = match Api::new(&owner.url) {
        Ok(api) => api,
        Err(e) => return refuse(format!("owner token: {e:#}")),
    };
    let mut seen = runs(&daemon.borrow());
    let mut checked = false;
    let mut said: Option<String> = None;
    /* The same failure every poll (server down) is logged once, until it changes. */
    let fail = |message: String, said: &mut Option<String>| {
        if said.as_deref() != Some(message.as_str()) {
            tracing::warn!("{message}");
        }
        tx.send_modify(|f| f.error = Some(message.clone()));
        *said = Some(message);
    };
    loop {
        if !checked {
            /* /api/wired would refuse an agent's token too, but this says why. */
            match api.me(&owner.token).await {
                Ok(me) if me.user.kind != "person" => {
                    return refuse(format!(
                        "owner_token is @{}, an agent; the box needs your own token for done and blocked",
                        me.user.handle
                    ));
                }
                Ok(me) => {
                    tracing::info!(url = %owner.url, "reading your agents' work as @{}", me.user.handle);
                    checked = true;
                }
                Err(e) if e.is_refusal() => return refuse(format!("owner token refused: {e}")),
                Err(e) => fail(format!("asking who the owner token is: {e}"), &mut said),
            }
        }
        if checked {
            match api.wired(&owner.token).await {
                Ok(w) => {
                    if said.take().is_some() {
                        tracing::info!("reading your agents' work again");
                    }
                    tx.send_modify(|f| {
                        f.wired = Some((w, SystemTime::now()));
                        f.error = None;
                    });
                }
                Err(e) if e.is_refusal() => return refuse(format!("reading /api/wired: {e}")),
                Err(e) => fail(format!("reading /api/wired: {e}"), &mut said),
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(EVERY) => {}
            _ = run_changed(&mut daemon, &mut seen) => tokio::time::sleep(SETTLE).await,
        }
    }
}
