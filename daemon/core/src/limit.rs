//! A runtime out of usage (COPL-195): the account it runs on has hit its limit,
//! so every run until the reset exits at once, saying so. That is the
//! account's trouble, not the task's: the run finishes as interrupted (no
//! strike toward blocked) and the agent is held on this machine until the
//! reset, or for a back-off when the runtime didn't say when.
//!
//! What they print, as of 2026-10:
//!
//! - Claude Code: "You've hit your session limit · resets 8:10pm (Europe/Istanbul)",
//!   "You've hit your weekly limit · resets Oct 30, 9am (…)", "5-hour limit reached ∙ resets 3pm",
//!   older "Claude AI usage limit reached|1761500000" (the reset in Unix seconds); with
//!   `--output-format json` the same text is the result's, with `is_error`.
//! - Codex: "You've hit your usage limit. … or try again at Oct 27th, 2025 3:38 PM.",
//!   older "… Try again in 4 days 20 hours 9 minutes."
//!
//! A clock time is read in this machine's time zone, which is the one the runtime printed it in
//! when it runs here. A reset that doesn't parse, is past, or is further off than `FURTHEST` is
//! not trusted, and the back-off holds instead.

use std::time::{Duration, SystemTime};

/// How many of the run log's last lines are read for the runtime's last word.
pub const LAST_LINES: usize = 8;

/// The back-off when the runtime said no reset: the first, doubled each time after, up to `MOST`.
pub const FIRST: Duration = Duration::from_secs(15 * 60);
pub const MOST: Duration = Duration::from_secs(60 * 60);

/// A reset further off than this is a misreading (a weekly limit resets within 7 days).
const FURTHEST: Duration = Duration::from_secs(8 * 86_400);

/// A runtime that said it is out of usage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutOfUsage {
    /// The line that said it, trimmed.
    pub said: String,
    /// When the usage resets, when the line said so and it reads right.
    pub resets: Option<SystemTime>,
}

/// Whether the end of a run's output (`tail`, its last lines) says the runtime is out of usage,
/// with when it resets. The daemon's own lines ("# …") are not the runtime's.
pub fn read(tail: &str, now: SystemTime) -> Option<OutOfUsage> {
    let lines: Vec<&str> = tail
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("# "))
        .collect();
    let line = lines.iter().rev().take(LAST_LINES).find(|l| out_of_usage(l))?;
    Some(OutOfUsage {
        said: line.to_string(),
        resets: resets(line, now),
    })
}

/// Whether a line is a runtime saying its account is out of usage. A rate limit (a 429, gone in
/// seconds) is not.
fn out_of_usage(line: &str) -> bool {
    let l = line.to_lowercase();
    if l.contains("rate limit") {
        return false;
    }
    l.contains("usage limit")
        || (l.contains("limit")
            && (l.contains("hit your") || l.contains("limit reached") || l.contains("reached your")))
}

/// When the line says the usage resets, if it says and that reads right: after `now` and within
/// `FURTHEST`.
fn resets(line: &str, now: SystemTime) -> Option<SystemTime> {
    let l = line.to_lowercase();
    let at = epoch(&l)
        .or_else(|| after(&l, "resets ").and_then(|s| when(s, now)))
        .or_else(|| after(&l, "try again at ").and_then(|s| when(s, now)))
        .or_else(|| after(&l, "try again in ").and_then(span).map(|d| now + d))?;
    (at > now && at < now + FURTHEST).then_some(at)
}

fn after<'a>(l: &'a str, word: &str) -> Option<&'a str> {
    l.find(word).map(|i| &l[i + word.len()..])
}

/// "…limit reached|1761500000": the reset in Unix seconds.
fn epoch(l: &str) -> Option<SystemTime> {
    let digits: String = after(l, "|")?.chars().take_while(char::is_ascii_digit).collect();
    if !(9..=11).contains(&digits.len()) {
        return None;
    }
    Some(SystemTime::UNIX_EPOCH + Duration::from_secs(digits.parse().ok()?))
}

/// A clock time as a runtime says it, with the date when it gives one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Clock {
    /// Month (0 is January) and day.
    date: Option<(i32, i32)>,
    year: Option<i32>,
    hour: i32,
    minute: i32,
}

const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

/// "8:10pm (europe/istanbul)", "oct 30, 9am", "oct 27th, 2025 3:38 pm.", "20:10".
fn clock(s: &str) -> Option<Clock> {
    let mut month = None;
    let mut day = None;
    let mut year = None;
    let mut words = s.split_whitespace().take(8).peekable();
    while let Some(word) = words.next() {
        let w = word.trim_end_matches([',', '.', '·', '∙']);
        let digits = w.chars().take_while(char::is_ascii_digit).count();
        if w == "at" {
            continue;
        }
        if month.is_none() && digits == 0 && w.len() >= 3 && w.chars().all(char::is_alphabetic) {
            month = Some(MONTHS.iter().position(|m| w.starts_with(m))? as i32);
            continue;
        }
        if month.is_some() && day.is_none() && (1..=2).contains(&digits) && !w.contains(':') {
            let suffix = &w[digits..];
            if ["", "st", "nd", "rd", "th"].contains(&suffix) {
                day = Some(w[..digits].parse().ok()?);
                continue;
            }
        }
        if digits == 4 && w.len() == 4 {
            year = Some(w.parse().ok()?);
            continue;
        }
        /* The time: "8:10pm", "8pm", "3:38" then "pm", "20:10". */
        let (hm, mut half) = match w.strip_suffix("am").or_else(|| w.strip_suffix("pm")) {
            Some(hm) => (hm, Some(w.ends_with("pm"))),
            None => (w, None),
        };
        let (h, m) = match hm.split_once(':') {
            Some((h, m)) => (h.parse::<i32>().ok()?, m.parse::<i32>().ok()?),
            None => (hm.parse::<i32>().ok()?, 0),
        };
        if half.is_none() {
            if let Some(next) = words.peek().map(|n| n.trim_end_matches([',', '.'])) {
                if next == "am" || next == "pm" {
                    half = Some(next == "pm");
                }
            }
        }
        let hour = match half {
            Some(pm) if (1..=12).contains(&h) => h % 12 + if pm { 12 } else { 0 },
            Some(_) => return None,
            None if (0..24).contains(&h) && hm.contains(':') => h,
            None => return None,
        };
        if !(0..60).contains(&m) {
            return None;
        }
        return Some(Clock {
            date: month.zip(day),
            year,
            hour,
            minute: m,
        });
    }
    None
}

/// The next time after `now` the clock in `s` reads, in this machine's time zone: today or
/// tomorrow when it gives no date, that date this year or next when it gives no year.
fn when(s: &str, now: SystemTime) -> Option<SystemTime> {
    let c = clock(s)?;
    let secs = now.duration_since(SystemTime::UNIX_EPOCH).ok()?.as_secs() as libc::time_t;
    // SAFETY: localtime_r writes only the tm it is given; a zeroed tm is a valid one.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::localtime_r(&secs, &mut tm) }.is_null() {
        return None;
    }
    tm.tm_hour = c.hour;
    tm.tm_min = c.minute;
    tm.tm_sec = 0;
    tm.tm_isdst = -1;
    if let Some((month, day)) = c.date {
        tm.tm_mon = month;
        tm.tm_mday = day;
    }
    if let Some(y) = c.year {
        tm.tm_year = y - 1900;
    }
    let mut at = local(tm)?;
    if at <= secs && c.year.is_none() {
        /* Already past: tomorrow's, or next year's when it named a date. */
        if c.date.is_some() {
            tm.tm_year += 1;
        } else {
            tm.tm_mday += 1;
        }
        tm.tm_isdst = -1;
        at = local(tm)?;
    }
    (at >= 0).then(|| SystemTime::UNIX_EPOCH + Duration::from_secs(at as u64))
}

/// A local time to Unix seconds (mktime, which also carries a day past the month's end over).
fn local(mut tm: libc::tm) -> Option<libc::time_t> {
    // SAFETY: mktime reads and normalises the tm it is given.
    let t = unsafe { libc::mktime(&mut tm) };
    (t != -1).then_some(t)
}

/// "4 days 20 hours 9 minutes", "2 hours.": how long until the reset.
fn span(s: &str) -> Option<Duration> {
    let mut total = 0u64;
    let mut words = s.split_whitespace();
    while let Some(n) = words.next().and_then(|w| w.parse::<u64>().ok()) {
        let unit = words.next()?.trim_end_matches([',', '.']);
        total += n * match unit.trim_end_matches('s') {
            "day" => 86_400,
            "hour" | "hr" | "h" => 3_600,
            "minute" | "min" | "m" => 60,
            "second" | "sec" => 1,
            _ => return None,
        };
    }
    (total > 0).then(|| Duration::from_secs(total))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-10-26 13:33:00 UTC.
    fn now() -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_792_935_180)
    }

    /// What `t` reads on this machine's clock: (month from 0, day, hour, minute).
    fn reads(t: SystemTime) -> (i32, i32, i32, i32) {
        let secs = t.duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs() as libc::time_t;
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        unsafe { libc::localtime_r(&secs, &mut tm) };
        (tm.tm_mon, tm.tm_mday, tm.tm_hour, tm.tm_min)
    }

    #[test]
    fn knows_claude_codes_session_limit() {
        let tail = "Working on it\nYou've hit your session limit · resets 8:10pm (Europe/Istanbul)\n# usage: $0.00 · 0 tokens\n";
        let o = read(tail, now()).expect("out of usage");
        assert_eq!(
            o.said,
            "You've hit your session limit · resets 8:10pm (Europe/Istanbul)"
        );
        let at = o.resets.expect("a reset");
        assert!(
            at > now() && at <= now() + Duration::from_secs(86_400),
            "the next 20:10"
        );
        let (_, _, hour, minute) = reads(at);
        assert_eq!((hour, minute), (20, 10));
    }

    #[test]
    fn reads_the_json_result_too() {
        /* A result Copland's usage reader passed by is in the log as it came. */
        let tail = r#"{"type":"result","subtype":"success","is_error":true,"result":"You've hit your weekly limit · resets Oct 30, 9am (Europe/Istanbul)","usage":{}}"#;
        let at = read(tail, now()).unwrap().resets.unwrap();
        assert_eq!(reads(at), (9, 30, 9, 0));
    }

    #[test]
    fn knows_the_other_ways_it_is_said() {
        for (line, reset) in [
            ("5-hour limit reached ∙ resets 3pm", true),
            ("Claude AI usage limit reached|1792950000", true),
            (
                "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 27th, 2026 3:38 PM.",
                true,
            ),
            (
                "■ You've hit your usage limit. Try again in 4 days 20 hours 9 minutes.",
                true,
            ),
            ("You've reached your usage limit.", false),
        ] {
            let o = read(line, now()).unwrap_or_else(|| panic!("{line}"));
            assert_eq!(o.resets.is_some(), reset, "{line}");
        }
        assert_eq!(
            read("Claude AI usage limit reached|1792950000", now()).unwrap().resets,
            Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1_792_950_000))
        );
        assert_eq!(
            read(
                "Try again in 4 days 20 hours 9 minutes. You've hit your usage limit",
                now()
            )
            .unwrap()
            .resets,
            Some(now() + Duration::from_secs(4 * 86_400 + 20 * 3600 + 9 * 60))
        );
        let at = read("try again at Oct 27th, 2026 3:38 PM.", now());
        assert_eq!(at, None, "no limit said");
        let at = read("usage limit; try again at Oct 27th, 2026 3:38 PM.", now())
            .unwrap()
            .resets
            .unwrap();
        assert_eq!(reads(at), (9, 27, 15, 38));
    }

    #[test]
    fn a_reset_that_reads_wrong_is_not_trusted() {
        for line in [
            "You've hit your session limit · resets soon",
            "You've hit your session limit · resets 25pm",
            "Claude AI usage limit reached|1700000000",
            "You've hit your usage limit. Try again at Jan 1st, 2031 3:38 PM.",
        ] {
            assert_eq!(read(line, now()).unwrap().resets, None, "{line}");
        }
    }

    #[test]
    fn anything_else_is_not_out_of_usage() {
        for tail in [
            "",
            "Done: opened the PR.",
            "API Error: 429 rate limit reached, retrying",
            "error: could not compile",
            "# copland-daemon: You've hit your session limit",
        ] {
            assert_eq!(read(tail, now()), None, "{tail}");
        }
        /* Only the runtime's last word counts: the limit long before it was something else. */
        let tail = format!("You've hit your usage limit\n{}", "more work\n".repeat(LAST_LINES));
        assert_eq!(read(&tail, now()), None);
    }

    #[test]
    fn clocks() {
        let c = |s| clock(s).map(|c| (c.date, c.year, c.hour, c.minute));
        assert_eq!(c("8:10pm (europe/istanbul)"), Some((None, None, 20, 10)));
        assert_eq!(c("12am"), Some((None, None, 0, 0)));
        assert_eq!(c("12:30pm"), Some((None, None, 12, 30)));
        assert_eq!(c("20:10"), Some((None, None, 20, 10)));
        assert_eq!(c("oct 30, 9am (x)"), Some((Some((9, 30)), None, 9, 0)));
        assert_eq!(c("oct 27th, 2025 3:38 pm."), Some((Some((9, 27)), Some(2025), 15, 38)));
        assert_eq!(c("at 3pm"), Some((None, None, 15, 0)));
        assert_eq!(c("8"), None, "no am, pm or minutes: not a time");
        assert_eq!(c("13pm"), None);
        assert_eq!(c("soon"), None);
    }

    #[test]
    fn a_time_already_past_today_is_tomorrows() {
        let (_, _, h, m) = reads(now());
        let earlier = format!("{}:{:02}", (h + 23) % 24, m);
        let at = when(&earlier, now()).unwrap();
        let ahead = at.duration_since(now()).unwrap();
        assert!(
            ahead > Duration::from_secs(22 * 3600) && ahead <= Duration::from_secs(24 * 3600 + 3600),
            "{ahead:?}"
        );
    }
}
