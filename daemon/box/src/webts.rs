//! Reading the web scene's numbers out of its TypeScript, for the tests that keep the box's
//! hand port in step (`scene.rs` against `scene.ts`, `view.rs` against `WiredPane.tsx`).
//!
//! Not a TypeScript parser: it finds `const NAME = …;` lines and evaluates arithmetic
//! (numbers, names, `+ - * /`, parentheses, `X[i]`, `Math.*` and calls the caller
//! answers). That is all the scene's geometry is written in; something it can't read
//! fails the test that asked for it, which is the point.

use std::collections::BTreeMap;

/// A file of the web app, by its path from the repo root.
pub fn read(path: &str) -> String {
    let full = format!("{}/../../{path}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&full).unwrap_or_else(|e| panic!("reading {path}: {e}"))
}

/// Every top-level `const NAME = <expr>;` (exported or not) whose value is a number, or an
/// array of numbers (`X[0]`, `X[1]`, …), evaluated in order against the ones before it.
/// Anything else (strings, arrow functions, objects) is left out.
pub fn consts(src: &str) -> BTreeMap<String, f64> {
    let mut env = BTreeMap::new();
    for line in src.lines() {
        let Some(rest) = line
            .strip_prefix("export const ")
            .or_else(|| line.strip_prefix("const "))
        else {
            continue;
        };
        let Some((name, expr)) = rest.split_once(" = ") else {
            continue;
        };
        if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            continue; /* typed, like `HUE: Record<…>` */
        }
        let expr = expr.trim_end_matches(';').trim();
        let expr = expr.strip_suffix(" as const").unwrap_or(expr);
        if let Some(items) = expr.strip_prefix('[').and_then(|e| e.strip_suffix(']')) {
            let vals: Option<Vec<f64>> = split_args(items)
                .iter()
                .map(|e| eval(e, &|n| env.get(n).copied()))
                .collect();
            if let Some(vals) = vals {
                for (i, v) in vals.into_iter().enumerate() {
                    env.insert(format!("{name}[{i}]"), v);
                }
            }
        } else if let Some(v) = eval(expr, &|n| env.get(n).copied()) {
            env.insert(name.to_string(), v);
        }
    }
    env
}

/// The text between `open` and the line that closes it (`close`, matched at the
/// same indentation as `open`'s line), for picking a function's body out of a file.
pub fn block<'a>(src: &'a str, open: &str, close: &str) -> &'a str {
    let start = src.find(open).unwrap_or_else(|| panic!("no `{open}`"));
    let indent = src[..start].rsplit('\n').next().unwrap().len();
    let body = &src[start + open.len()..];
    let end = body
        .find(&format!("\n{}{close}", " ".repeat(indent)))
        .unwrap_or_else(|| panic!("no `{close}` closing `{open}`"));
    &body[..end]
}

/// `a, f(b, c), d` split at its top-level commas, trimmed, empty pieces dropped.
pub fn split_args(s: &str) -> Vec<&str> {
    let (mut depth, mut from, mut out) = (0, 0, Vec::new());
    for (i, ch) in s.char_indices() {
        match ch {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            ',' if depth == 0 => {
                out.push(s[from..i].trim());
                from = i + 1;
            }
            _ => {}
        }
    }
    out.push(s[from..].trim());
    out.retain(|p| !p.is_empty());
    out
}

/// Evaluates `expr` with names from `env`; `Math.*` built in. None for what it can't read.
pub fn eval(expr: &str, env: &dyn Fn(&str) -> Option<f64>) -> Option<f64> {
    eval_with(expr, env, &|_, _| None)
}

/// As `eval`, with other calls (`sway(ph)`) answered by `call`.
pub fn eval_with(
    expr: &str,
    env: &dyn Fn(&str) -> Option<f64>,
    call: &dyn Fn(&str, &[f64]) -> Option<f64>,
) -> Option<f64> {
    let tokens = lex(expr)?;
    let mut p = Parser {
        t: &tokens,
        i: 0,
        env,
        call,
    };
    let v = p.sum()?;
    (p.i == tokens.len()).then_some(v)
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64),
    Name(String),
    Op(char),
}

fn lex(s: &str) -> Option<Vec<Tok>> {
    let b: Vec<char> = s.chars().collect();
    let (mut i, mut out) = (0, Vec::new());
    while i < b.len() {
        let c = b[i];
        if c.is_whitespace() {
            i += 1;
        } else if c.is_ascii_digit() || (c == '.' && b.get(i + 1).is_some_and(char::is_ascii_digit)) {
            let start = i;
            while i < b.len() && (b[i].is_ascii_digit() || b[i] == '.' || b[i] == '_') {
                i += 1;
            }
            let n: String = b[start..i].iter().filter(|&&c| c != '_').collect();
            out.push(Tok::Num(n.parse().ok()?));
        } else if c.is_ascii_alphabetic() || c == '_' {
            let start = i;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == '_' || b[i] == '.') {
                i += 1;
            }
            out.push(Tok::Name(b[start..i].iter().collect()));
        } else if "+-*/()[],".contains(c) {
            out.push(Tok::Op(c));
            i += 1;
        } else {
            return None;
        }
    }
    Some(out)
}

struct Parser<'a> {
    t: &'a [Tok],
    i: usize,
    env: &'a dyn Fn(&str) -> Option<f64>,
    call: &'a dyn Fn(&str, &[f64]) -> Option<f64>,
}

impl Parser<'_> {
    fn eat(&mut self, op: char) -> bool {
        if self.t.get(self.i) == Some(&Tok::Op(op)) {
            self.i += 1;
            true
        } else {
            false
        }
    }

    fn sum(&mut self) -> Option<f64> {
        let mut v = self.product()?;
        loop {
            if self.eat('+') {
                v += self.product()?;
            } else if self.eat('-') {
                v -= self.product()?;
            } else {
                return Some(v);
            }
        }
    }

    fn product(&mut self) -> Option<f64> {
        let mut v = self.unary()?;
        loop {
            if self.eat('*') {
                v *= self.unary()?;
            } else if self.eat('/') {
                v /= self.unary()?;
            } else {
                return Some(v);
            }
        }
    }

    fn unary(&mut self) -> Option<f64> {
        if self.eat('-') {
            return Some(-self.unary()?);
        }
        if self.eat('(') {
            let v = self.sum()?;
            return self.eat(')').then_some(v);
        }
        match self.t.get(self.i)?.clone() {
            Tok::Num(n) => {
                self.i += 1;
                Some(n)
            }
            Tok::Name(name) => {
                self.i += 1;
                if self.eat('(') {
                    let mut args = Vec::new();
                    if !self.eat(')') {
                        loop {
                            args.push(self.sum()?);
                            if self.eat(')') {
                                break;
                            }
                            if !self.eat(',') {
                                return None;
                            }
                        }
                    }
                    math(&name, &args).or_else(|| (self.call)(&name, &args))
                } else if self.eat('[') {
                    let i = self.sum()?;
                    self.eat(']').then_some(())?;
                    (self.env)(&format!("{name}[{i}]"))
                } else {
                    (self.env)(&name)
                }
            }
            Tok::Op(_) => None,
        }
    }
}

fn math(name: &str, a: &[f64]) -> Option<f64> {
    Some(match (name, a) {
        ("Math.max", _) if !a.is_empty() => a.iter().copied().fold(f64::MIN, f64::max),
        ("Math.min", _) if !a.is_empty() => a.iter().copied().fold(f64::MAX, f64::min),
        ("Math.floor", [x]) => x.floor(),
        ("Math.abs", [x]) => x.abs(),
        ("Math.sin", [x]) => x.sin(),
        ("Math.cosh", [x]) => x.cosh(),
        ("Math.hypot", [x, y]) => x.hypot(*y),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_the_scene_is_written_in() {
        let src = "export const A = 64;\nconst B = 10 + A / 2;\nconst C = [1, B - 2 * 3, -(A)] as const;\nconst D = C[1] + 1_000;\nconst S = \"x\";\n";
        let c = consts(src);
        assert_eq!(c["A"], 64.0);
        assert_eq!(c["B"], 42.0);
        assert_eq!(c["C[1]"], 36.0);
        assert_eq!(c["C[2]"], -64.0);
        assert_eq!(c["D"], 1036.0);
        assert!(!c.contains_key("S"));
        assert_eq!(
            eval("Math.max(0.12, 0.7 - i * 0.2)", &|n| (n == "i").then_some(3.0)),
            Some(0.12)
        );
        assert_eq!(eval("2 *", &|_| None), None);
        assert_eq!(split_args("a, f(b, c), [d, e]"), ["a", "f(b, c)", "[d, e]"]);
    }
}
