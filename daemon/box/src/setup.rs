//! Setup's parts the box keeps: the window's one-line text input and the box's
//! own name. The rest is core's (`copland_daemon_core::setup`), re-exported here
//! for `wizard.rs`, which draws and drives them.

pub use copland_daemon_core::setup::*;

/// What the box calls itself to the server, and in each agent's history.
pub const CLIENT: &str = "copland-box";

/// A single line being typed: the text and a cursor between characters.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LineInput {
    text: String,
    /// A byte offset on a character boundary.
    cursor: usize,
}

impl LineInput {
    pub fn new(text: &str) -> Self {
        let mut i = Self::default();
        i.insert(text);
        i
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    /// The text either side of the cursor.
    pub fn split(&self) -> (&str, &str) {
        self.text.split_at(self.cursor)
    }

    /// Typed or pasted text at the cursor: its first line, without control characters.
    pub fn insert(&mut self, s: &str) {
        let line = s.trim_start_matches(['\r', '\n']).lines().next().unwrap_or("");
        let clean: String = line.chars().filter(|c| !c.is_control()).collect();
        self.text.insert_str(self.cursor, &clean);
        self.cursor += clean.len();
    }

    fn prev(&self) -> usize {
        self.text[..self.cursor]
            .char_indices()
            .next_back()
            .map_or(0, |(i, _)| i)
    }

    fn next(&self) -> usize {
        self.text[self.cursor..]
            .chars()
            .next()
            .map_or(self.cursor, |c| self.cursor + c.len_utf8())
    }

    pub fn backspace(&mut self) {
        let from = self.prev();
        self.text.replace_range(from..self.cursor, "");
        self.cursor = from;
    }

    pub fn delete(&mut self) {
        let to = self.next();
        self.text.replace_range(self.cursor..to, "");
    }

    /// Back to the start of the word before the cursor (ctrl-w, ctrl-backspace).
    pub fn delete_word(&mut self) {
        let before = &self.text[..self.cursor];
        let trimmed = before.trim_end_matches(|c: char| !c.is_alphanumeric());
        let from = trimmed
            .char_indices()
            .rev()
            .find(|(_, c)| !c.is_alphanumeric())
            .map_or(0, |(i, c)| i + c.len_utf8());
        self.text.replace_range(from..self.cursor, "");
        self.cursor = from;
    }

    pub fn left(&mut self) {
        self.cursor = self.prev();
    }

    pub fn right(&mut self) {
        self.cursor = self.next();
    }

    pub fn home(&mut self) {
        self.cursor = 0;
    }

    pub fn end(&mut self) {
        self.cursor = self.text.len();
    }

    pub fn clear(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(text: &str, cursor: usize) -> LineInput {
        let mut i = LineInput::new(text);
        i.cursor = cursor;
        i
    }

    #[test]
    fn edits_a_line() {
        let mut i = LineInput::new("copland.dev");
        assert_eq!(i.split(), ("copland.dev", ""));
        i.backspace();
        i.backspace();
        i.backspace();
        i.insert("xyz");
        assert_eq!(i.text(), "copland.xyz");
        i.home();
        i.insert("https://");
        assert_eq!(i.split(), ("https://", "copland.xyz"));
        i.delete();
        assert_eq!(i.text(), "https://opland.xyz");
        i.end();
        i.left();
        i.left();
        i.right();
        assert_eq!(i.split(), ("https://opland.xy", "z"));
        /* Walking past either end stays put. */
        i.home();
        i.left();
        i.backspace();
        assert_eq!(i.split(), ("", "https://opland.xyz"));
        i.end();
        i.right();
        i.delete();
        assert_eq!(i.text(), "https://opland.xyz");
    }

    #[test]
    fn keeps_to_character_boundaries() {
        let mut i = LineInput::new("çay·");
        i.backspace();
        assert_eq!(i.text(), "çay");
        i.home();
        i.right();
        assert_eq!(i.split(), ("ç", "ay"));
        i.delete();
        assert_eq!(i.text(), "çy");
    }

    #[test]
    fn pastes_one_clean_line() {
        let mut i = input("", 0);
        i.insert("\n  copland.example.com\tx\nsecond line");
        assert_eq!(i.text(), "  copland.example.comx");
        i.clear();
        assert_eq!(i, LineInput::default());
    }

    #[test]
    fn deletes_a_word() {
        let mut i = LineInput::new("https://copland.example.com");
        i.delete_word();
        assert_eq!(i.text(), "https://copland.example.");
        i.delete_word();
        assert_eq!(i.text(), "https://copland.");
        let mut i = LineInput::new("abc");
        i.delete_word();
        assert_eq!(i.text(), "");
    }
}
