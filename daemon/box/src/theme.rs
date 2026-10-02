//! Copland's seven themes, as role colours. A copy of `src/styles/themes.css`:
//! the roles are the app's (DESIGN.md), the values must be kept in step with
//! that file by hand. `tests::matches_the_web_themes` reads the CSS and fails
//! when they drift.

/// An sRGB colour, 0–255 per channel, as the CSS gives it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rgb(pub f32, pub f32, pub f32);

const fn rgb(r: u8, g: u8, b: u8) -> Rgb {
    Rgb(r as f32, g as f32, b as f32)
}

impl Rgb {
    /// `a` toward `b` by `t`, per channel, as the prototype's `mix`.
    pub fn mix(self, b: Rgb, t: f32) -> Rgb {
        Rgb(
            self.0 + (b.0 - self.0) * t,
            self.1 + (b.1 - self.1) * t,
            self.2 + (b.2 - self.2) * t,
        )
    }
}

/// The role variables of one theme. Field names are the CSS variables' without `--`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Theme {
    pub name: &'static str,
    pub surface: Rgb,
    pub raised: Rgb,
    pub bar: Rgb,
    pub divider: Rgb,
    pub ink: Rgb,
    pub bright: Rgb,
    pub muted: Rgb,
    pub faint: Rgb,
    pub accent: Rgb,
    pub red: Rgb,
    pub orange: Rgb,
    pub yellow: Rgb,
    pub green: Rgb,
    pub magenta: Rgb,
    pub blue: Rgb,
    pub cyan: Rgb,
    pub teal: Rgb,
}

pub const DEFAULT: &str = "nord";

pub const THEMES: [Theme; 7] = [
    Theme {
        name: "nord",
        surface: rgb(38, 43, 53),
        raised: rgb(49, 56, 71),
        bar: rgb(30, 42, 58),
        divider: rgb(23, 28, 38),
        ink: rgb(216, 222, 233),
        bright: rgb(236, 239, 244),
        muted: rgb(97, 110, 136),
        faint: rgb(76, 86, 106),
        accent: rgb(136, 192, 208),
        red: rgb(191, 97, 106),
        orange: rgb(208, 135, 112),
        yellow: rgb(235, 203, 139),
        green: rgb(163, 190, 140),
        magenta: rgb(180, 142, 173),
        blue: rgb(129, 161, 193),
        cyan: rgb(136, 192, 208),
        teal: rgb(143, 188, 187),
    },
    Theme {
        name: "tokyo-night",
        surface: rgb(26, 27, 38),
        raised: rgb(36, 40, 59),
        bar: rgb(22, 22, 30),
        divider: rgb(14, 14, 21),
        ink: rgb(169, 177, 214),
        bright: rgb(192, 202, 245),
        muted: rgb(86, 95, 137),
        faint: rgb(59, 66, 97),
        accent: rgb(122, 162, 247),
        red: rgb(247, 118, 142),
        orange: rgb(255, 158, 100),
        yellow: rgb(224, 175, 104),
        green: rgb(158, 206, 106),
        magenta: rgb(187, 154, 247),
        blue: rgb(122, 162, 247),
        cyan: rgb(125, 207, 255),
        teal: rgb(115, 218, 202),
    },
    Theme {
        name: "dracula",
        surface: rgb(40, 42, 54),
        raised: rgb(52, 55, 70),
        bar: rgb(33, 34, 44),
        divider: rgb(25, 26, 33),
        ink: rgb(248, 248, 242),
        bright: rgb(255, 255, 255),
        muted: rgb(98, 114, 164),
        faint: rgb(68, 71, 90),
        accent: rgb(189, 147, 249),
        red: rgb(255, 85, 85),
        orange: rgb(255, 184, 108),
        yellow: rgb(241, 250, 140),
        green: rgb(80, 250, 123),
        magenta: rgb(255, 121, 198),
        blue: rgb(98, 114, 164),
        cyan: rgb(139, 233, 253),
        teal: rgb(139, 233, 253),
    },
    Theme {
        name: "catppuccin",
        surface: rgb(30, 30, 46),
        raised: rgb(49, 50, 68),
        bar: rgb(24, 24, 37),
        divider: rgb(17, 17, 27),
        ink: rgb(186, 194, 222),
        bright: rgb(205, 214, 244),
        muted: rgb(108, 112, 134),
        faint: rgb(69, 71, 90),
        accent: rgb(203, 166, 247),
        red: rgb(243, 139, 168),
        orange: rgb(250, 179, 135),
        yellow: rgb(249, 226, 175),
        green: rgb(166, 227, 161),
        magenta: rgb(245, 194, 231),
        blue: rgb(137, 180, 250),
        cyan: rgb(137, 220, 235),
        teal: rgb(148, 226, 213),
    },
    Theme {
        name: "gruvbox",
        surface: rgb(40, 40, 40),
        raised: rgb(60, 56, 54),
        bar: rgb(29, 32, 33),
        divider: rgb(20, 22, 23),
        ink: rgb(235, 219, 178),
        bright: rgb(251, 241, 199),
        muted: rgb(146, 131, 116),
        faint: rgb(80, 73, 69),
        accent: rgb(254, 128, 25),
        red: rgb(251, 73, 52),
        orange: rgb(254, 128, 25),
        yellow: rgb(250, 189, 47),
        green: rgb(184, 187, 38),
        magenta: rgb(211, 134, 155),
        blue: rgb(131, 165, 152),
        cyan: rgb(142, 192, 124),
        teal: rgb(142, 192, 124),
    },
    Theme {
        name: "one-dark",
        surface: rgb(40, 44, 52),
        raised: rgb(47, 52, 63),
        bar: rgb(33, 37, 43),
        divider: rgb(24, 27, 32),
        ink: rgb(171, 178, 191),
        bright: rgb(215, 218, 224),
        muted: rgb(92, 99, 112),
        faint: rgb(62, 68, 82),
        accent: rgb(97, 175, 239),
        red: rgb(224, 108, 117),
        orange: rgb(209, 154, 102),
        yellow: rgb(229, 192, 123),
        green: rgb(152, 195, 121),
        magenta: rgb(198, 120, 221),
        blue: rgb(97, 175, 239),
        cyan: rgb(86, 182, 194),
        teal: rgb(86, 182, 194),
    },
    Theme {
        name: "solarized",
        surface: rgb(0, 43, 54),
        raised: rgb(7, 54, 66),
        bar: rgb(0, 33, 43),
        divider: rgb(0, 18, 23),
        ink: rgb(131, 148, 150),
        bright: rgb(147, 161, 161),
        muted: rgb(88, 110, 117),
        faint: rgb(23, 68, 79),
        accent: rgb(38, 139, 210),
        red: rgb(220, 50, 47),
        orange: rgb(203, 75, 22),
        yellow: rgb(181, 137, 0),
        green: rgb(133, 153, 0),
        magenta: rgb(211, 54, 130),
        blue: rgb(38, 139, 210),
        cyan: rgb(42, 161, 152),
        teal: rgb(42, 161, 152),
    },
];

impl Theme {
    /// The theme by name; None for one Copland doesn't have.
    pub fn named(name: &str) -> Option<&'static Theme> {
        THEMES.iter().find(|t| t.name == name)
    }

    pub fn names() -> impl Iterator<Item = &'static str> {
        THEMES.iter().map(|t| t.name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every `--role: r g b;` under each `[data-theme="…"]` in the web app's CSS, against the table.
    #[test]
    fn matches_the_web_themes() {
        let css = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../src/styles/themes.css"))
            .expect("reading src/styles/themes.css");
        let mut theme: Option<&Theme> = None;
        let mut seen = 0;
        let mut checked = 0;
        for line in css.lines() {
            /* Selectors only: the file's header comment mentions [data-theme="..."] too. */
            if let Some(rest) = line.trim_start().strip_prefix("[data-theme=\"") {
                let name = rest.split('"').next().unwrap();
                theme = Some(Theme::named(name).unwrap_or_else(|| panic!("themes.css has {name}, the box doesn't")));
                seen += 1;
                continue;
            }
            let (Some(t), Some(decl)) = (theme, line.trim().strip_prefix("--")) else {
                continue;
            };
            let Some((role, value)) = decl.trim_end_matches(';').split_once(':') else {
                continue;
            };
            let n: Vec<f32> = value.split_whitespace().filter_map(|v| v.parse().ok()).collect();
            if n.len() != 3 {
                continue;
            }
            let ours = match role {
                "surface" => t.surface,
                "raised" => t.raised,
                "bar" => t.bar,
                "divider" => t.divider,
                "ink" => t.ink,
                "bright" => t.bright,
                "muted" => t.muted,
                "faint" => t.faint,
                "accent" => t.accent,
                "red" => t.red,
                "orange" => t.orange,
                "yellow" => t.yellow,
                "green" => t.green,
                "magenta" => t.magenta,
                "blue" => t.blue,
                "cyan" => t.cyan,
                "teal" => t.teal,
                other => panic!("themes.css has a role the box doesn't: --{other}"),
            };
            assert_eq!(ours, Rgb(n[0], n[1], n[2]), "{} --{role}", t.name);
            checked += 1;
        }
        assert_eq!(seen, THEMES.len(), "themes.css and the box have different theme lists");
        assert_eq!(checked, THEMES.len() * 17);
    }

    #[test]
    fn nord_is_there() {
        assert!(Theme::named(DEFAULT).is_some());
        assert!(Theme::named("nope").is_none());
    }
}
