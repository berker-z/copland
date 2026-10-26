//! The tray as a StatusNotifierItem over D-Bus (`ksni`): draws a `View`, and sends what its menu
//! is asked for down a channel, to the main loop.

use std::collections::HashMap;

use tokio::sync::mpsc;

use crate::follow::Seen;
use crate::icons::{self, Pixmap};
use crate::view::{Action, Entry, Icon, View, view};

pub struct Tray {
    view: View,
    seen: Seen,
    /// Why opening the box failed, until the next thing seen.
    failed: Option<String>,
    icons: HashMap<Icon, Vec<ksni::Icon>>,
    actions: mpsc::UnboundedSender<Action>,
}

impl Tray {
    /// Not running, until `show` says otherwise.
    pub fn new(actions: mpsc::UnboundedSender<Action>) -> Self {
        let icons = Icon::ALL
            .into_iter()
            .map(|i| (i, icons::pixmaps(i).into_iter().map(pixmap).collect()))
            .collect();
        Self {
            view: view(None, None),
            seen: Seen::default(),
            failed: None,
            icons,
            actions,
        }
    }

    pub fn show(&mut self, seen: &Seen) {
        self.seen = seen.clone();
        self.failed = None;
        self.draw();
    }

    /// Say why the box didn't open, in place of the daemon's last error, until `show` again.
    pub fn fail(&mut self, why: String) {
        self.failed = Some(why);
        self.draw();
    }

    fn draw(&mut self) {
        let error = self.failed.as_deref().or(self.seen.error.as_deref());
        self.view = view(self.seen.status.as_ref(), error);
    }
}

fn pixmap(p: Pixmap) -> ksni::Icon {
    ksni::Icon {
        width: p.width as i32,
        height: p.height as i32,
        data: p.argb,
    }
}

/// A label as it is shown: dbusmenu takes a lone `_` for an access key.
fn label(text: &str) -> String {
    text.replace('_', "__")
}

/// A tooltip line as it is shown: the description takes a subset of HTML.
fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

impl ksni::Tray for Tray {
    /* The menu on a left click too, where "Open the box" is first: a click that opened the box
    straight away would leave no way to the menu on hosts that show it only on a left click. */
    const MENU_ON_ACTIVATE: bool = true;

    fn id(&self) -> String {
        "copland-tray".into()
    }

    fn title(&self) -> String {
        self.view.title.clone()
    }

    fn icon_pixmap(&self) -> Vec<ksni::Icon> {
        self.icons[&self.view.icon].clone()
    }

    fn tool_tip(&self) -> ksni::ToolTip {
        ksni::ToolTip {
            title: self.view.title.clone(),
            description: self
                .view
                .tooltip
                .iter()
                .map(|l| escape(l))
                .collect::<Vec<_>>()
                .join("\n"),
            ..Default::default()
        }
    }

    fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
        self.view
            .menu
            .iter()
            .map(|e| match e {
                Entry::Separator => ksni::MenuItem::Separator,
                Entry::Item { label: text, action } => {
                    let action = action.clone();
                    ksni::menu::StandardItem {
                        label: label(text),
                        enabled: action.is_some(),
                        activate: Box::new(move |tray: &mut Self| {
                            if let Some(a) = &action {
                                let _ = tray.actions.send(a.clone());
                            }
                        }),
                        ..Default::default()
                    }
                    .into()
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_and_tooltips_are_escaped() {
        assert_eq!(label("Hold my_agent on this machine"), "Hold my__agent on this machine");
        assert_eq!(escape("a <b> & c"), "a &lt;b&gt; &amp; c");
    }

    #[test]
    fn the_item_draws_the_view_and_its_menu_sends_actions() {
        use ksni::Tray as _;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut tray = Tray::new(tx);
        assert_eq!(tray.icon_pixmap().len(), icons::SIZES.len());
        assert_eq!(tray.tool_tip().description, "not running");
        let menu = tray.menu();
        let Some(ksni::MenuItem::Standard(quit)) = menu.last() else {
            panic!("Quit tray last");
        };
        assert_eq!(quit.label, "Quit tray");
        assert!(quit.enabled);
        (quit.activate)(&mut tray);
        assert_eq!(rx.try_recv().unwrap(), Action::Quit);
        let Some(ksni::MenuItem::Standard(open)) = menu.first() else {
            panic!("Open the box first");
        };
        assert_eq!(open.label, "Open the box");
        (open.activate)(&mut tray);
        assert_eq!(rx.try_recv().unwrap(), Action::OpenBox);
        let Some(ksni::MenuItem::Standard(note)) = menu.get(2) else {
            panic!("a note after it");
        };
        assert!(!note.enabled);
        tray.show(&Seen {
            status: None,
            error: Some("x".into()),
        });
        assert_eq!(tray.tool_tip().description, "not running\n× x");
        /* A box that didn't open is said until the next thing seen. */
        tray.fail("no copland-box".into());
        assert_eq!(tray.tool_tip().description, "not running\n× no copland-box");
        tray.show(&Seen::default());
        assert_eq!(tray.tool_tip().description, "not running");
    }
}
