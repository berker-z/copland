//! What a run cost (COPL-71), read from what its runtime printed: Claude Code's
//! `--output-format json` result, one line of JSON at the end of its stdout
//! (`Runtime::command` asks for it). The runner hands each line of the
//! runtime's stdout to `read_line`: the result goes to the run log as the
//! text Claude Code would have printed without the flag and a line of usage,
//! so the log reads as it did, and the usage goes to Copland with the run's
//! finish (`usage` in `POST /api/runs/:id/finish`, `runUsage` in
//! `src/domain/runs.ts`). Codex reports usage only in `codex exec --json`'s
//! event stream, which would make its log unreadable; its runs send none yet.

use serde::Serialize;
use serde_json::Value;

/// One run's usage, the way Copland takes it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    /// Fresh input tokens, not read from the cache.
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    /// In dollars, as the runtime worked it out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turns: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// The run resumed an earlier session. Never yet: every run starts fresh
    /// (`--no-session-persistence`) until COPL-188's resume lands.
    pub resumed: bool,
}

impl Usage {
    /// "$0.84 · 1.3M tokens (in 12k, out 3.1k, cache read 1.2M, cache write 40k) · 23 turns · 4m 2s":
    /// the run log's usage line, after `# usage: `.
    pub fn line(&self) -> String {
        let total = self.input_tokens + self.output_tokens + self.cache_read_tokens + self.cache_write_tokens;
        let mut parts = Vec::new();
        if let Some(c) = self.cost_usd {
            parts.push(format!("${c:.2}"));
        }
        parts.push(format!(
            "{} tokens (in {}, out {}, cache read {}, cache write {})",
            count(total),
            count(self.input_tokens),
            count(self.output_tokens),
            count(self.cache_read_tokens),
            count(self.cache_write_tokens)
        ));
        if let Some(t) = self.turns {
            parts.push(format!("{t} turn{}", if t == 1 { "" } else { "s" }));
        }
        if let Some(ms) = self.duration_ms {
            parts.push(crate::runner::took(std::time::Duration::from_millis(ms)));
        }
        parts.join(" · ")
    }
}

/// "312", "48k", "1.3M": a token count the way Copland's `tokenCount` says it.
fn count(n: u64) -> String {
    let short = |x: f64| {
        if x >= 10.0 {
            format!("{}", x.round())
        } else {
            let r = (x * 10.0).round() / 10.0;
            if r.fract() == 0.0 {
                format!("{r:.0}")
            } else {
                format!("{r:.1}")
            }
        }
    };
    if n >= 999_500 {
        format!("{}M", short(n as f64 / 1e6))
    } else if n >= 1000 {
        format!("{}k", short(n as f64 / 1e3))
    } else {
        n.to_string()
    }
}

/// A runtime's final result, read off one line of its stdout.
#[derive(Debug, Clone, PartialEq)]
pub struct Result {
    /// What goes in the run log in its place: the result's text, as the runtime prints it
    /// without `--output-format json`, or why there is none.
    pub text: String,
    pub usage: Usage,
}

/// The result, when `line` is Claude Code's JSON one (`"type":"result"` with its usage); None for
/// anything else, which goes to the log as it is.
pub fn read_line(line: &str) -> Option<Result> {
    let line = line.trim();
    if !line.starts_with('{') {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    if v.get("type")?.as_str()? != "result" {
        return None;
    }
    let n = |v: &Value, k: &str| v.get(k).and_then(Value::as_u64).unwrap_or(0);
    /* Every model the run used (a subagent's too), summed; the top-level usage is the main model's. */
    let models: Vec<&Value> = v
        .get("modelUsage")
        .and_then(Value::as_object)
        .map(|m| m.values().collect())
        .unwrap_or_default();
    let usage = if !models.is_empty() {
        let sum = |k: &str| models.iter().map(|m| n(m, k)).sum::<u64>();
        (
            sum("inputTokens"),
            sum("outputTokens"),
            sum("cacheReadInputTokens"),
            sum("cacheCreationInputTokens"),
        )
    } else {
        let u = v.get("usage")?;
        (
            n(u, "input_tokens"),
            n(u, "output_tokens"),
            n(u, "cache_read_input_tokens"),
            n(u, "cache_creation_input_tokens"),
        )
    };
    let text = match v.get("result").and_then(Value::as_str) {
        Some(r) => r.to_string(),
        None => format!(
            "# copland-daemon: the runtime's result has no text ({})",
            v.get("subtype").and_then(Value::as_str).unwrap_or("no subtype")
        ),
    };
    Some(Result {
        text,
        usage: Usage {
            input_tokens: usage.0,
            output_tokens: usage.1,
            cache_read_tokens: usage.2,
            cache_write_tokens: usage.3,
            cost_usd: v
                .get("total_cost_usd")
                .and_then(Value::as_f64)
                .filter(|c| c.is_finite() && *c >= 0.0),
            turns: v.get("num_turns").and_then(Value::as_u64),
            duration_ms: v.get("duration_ms").and_then(Value::as_u64),
            resumed: false,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What Claude Code 2.1.301 printed for `claude -p … --output-format json`, trimmed.
    const CLAUDE: &str = r#"{"duration_api_ms":1377,"stop_reason":"end_turn","session_id":"7006f296","total_cost_usd":0.0169698,"usage":{"input_tokens":2,"cache_creation_input_tokens":2094,"cache_read_input_tokens":649,"output_tokens":4},"modelUsage":{"claude-opus-5-5":{"inputTokens":2,"outputTokens":4,"cacheReadInputTokens":649,"cacheCreationInputTokens":2094,"costUSD":0.0169698}},"permission_denials":[],"is_error":false,"num_turns":1,"subtype":"success","result":"ok","type":"result","duration_ms":1488}"#;

    #[test]
    fn reads_claude_codes_result() {
        let r = read_line(CLAUDE).unwrap();
        assert_eq!(r.text, "ok");
        assert_eq!(
            r.usage,
            Usage {
                input_tokens: 2,
                output_tokens: 4,
                cache_read_tokens: 649,
                cache_write_tokens: 2094,
                cost_usd: Some(0.0169698),
                turns: Some(1),
                duration_ms: Some(1488),
                resumed: false,
            }
        );
        assert_eq!(
            r.usage.line(),
            "$0.02 · 2.7k tokens (in 2, out 4, cache read 649, cache write 2.1k) · 1 turn · 1.5s"
        );
    }

    #[test]
    fn sums_every_model_the_run_used() {
        let line = r#"{"type":"result","result":"done","usage":{"input_tokens":1,"output_tokens":1},
            "modelUsage":{"a":{"inputTokens":10,"outputTokens":20,"cacheReadInputTokens":1000,"cacheCreationInputTokens":5},
                          "b":{"inputTokens":1,"outputTokens":2,"cacheReadInputTokens":0,"cacheCreationInputTokens":0}}}"#
            .replace('\n', "");
        let u = read_line(&line).unwrap().usage;
        assert_eq!(
            (
                u.input_tokens,
                u.output_tokens,
                u.cache_read_tokens,
                u.cache_write_tokens
            ),
            (11, 22, 1000, 5)
        );
        assert_eq!((u.cost_usd, u.turns, u.duration_ms), (None, None, None));
    }

    #[test]
    fn falls_back_to_the_top_level_usage() {
        let u = read_line(r#"{"type":"result","result":"x","usage":{"input_tokens":3,"output_tokens":4,"cache_read_input_tokens":5,"cache_creation_input_tokens":6}}"#)
            .unwrap()
            .usage;
        assert_eq!(
            (
                u.input_tokens,
                u.output_tokens,
                u.cache_read_tokens,
                u.cache_write_tokens
            ),
            (3, 4, 5, 6)
        );
    }

    #[test]
    fn a_result_without_text_says_why() {
        let r = read_line(r#"{"type":"result","subtype":"error_max_turns","usage":{"input_tokens":1}}"#).unwrap();
        assert!(r.text.contains("error_max_turns"), "{}", r.text);
    }

    #[test]
    fn anything_else_is_left_alone() {
        for line in [
            "ok",
            "",
            "{not json",
            r#"{"type":"assistant","message":{}}"#,
            r#"{"type":"result"}"#,
            "[1,2]",
        ] {
            assert_eq!(read_line(line), None, "{line}");
        }
    }

    #[test]
    fn copland_takes_it_as_sent() {
        let r = read_line(CLAUDE).unwrap();
        assert_eq!(
            serde_json::to_value(&r.usage).unwrap(),
            serde_json::json!({
                "inputTokens": 2, "outputTokens": 4, "cacheReadTokens": 649, "cacheWriteTokens": 2094,
                "costUsd": 0.0169698, "turns": 1, "durationMs": 1488, "resumed": false
            })
        );
    }

    #[test]
    fn counts_read_as_coplands_do() {
        assert_eq!(count(312), "312");
        assert_eq!(count(48_200), "48k");
        assert_eq!(count(1_250_000), "1.3M");
        assert_eq!(count(999_999), "1M");
        assert_eq!(count(3_100), "3.1k");
    }
}
