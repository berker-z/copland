//! The tray's icons: the PNGs `daemon/release/tray-icons.sh` writes, embedded, and decoded at
//! startup to the ARGB32 (network byte order) a StatusNotifierItem's pixmap is. No icon theme, and
//! no SVG renderer in the build.

use crate::view::Icon;

/// The sizes each state comes in, in pixels.
pub const SIZES: [u32; 6] = [16, 22, 24, 32, 48, 64];

macro_rules! pngs {
    ($state:literal) => {
        [
            include_bytes!(concat!("../../release/tray/", $state, "/16.png")).as_slice(),
            include_bytes!(concat!("../../release/tray/", $state, "/22.png")),
            include_bytes!(concat!("../../release/tray/", $state, "/24.png")),
            include_bytes!(concat!("../../release/tray/", $state, "/32.png")),
            include_bytes!(concat!("../../release/tray/", $state, "/48.png")),
            include_bytes!(concat!("../../release/tray/", $state, "/64.png")),
        ]
    };
}

/// The PNGs of `icon`, one per size in `SIZES`.
fn pngs(icon: Icon) -> [&'static [u8]; 6] {
    match icon {
        Icon::Idle => pngs!("idle"),
        Icon::Working => pngs!("working"),
        Icon::Needs => pngs!("needs"),
        Icon::Stopped => pngs!("stopped"),
    }
}

/// One size of an icon, ARGB32 in network byte order, row by row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pixmap {
    pub width: u32,
    pub height: u32,
    pub argb: Vec<u8>,
}

/// Every size of `icon`, smallest first.
pub fn pixmaps(icon: Icon) -> Vec<Pixmap> {
    pngs(icon)
        .iter()
        .map(|png| decode(png).unwrap_or_else(|e| panic!("the {} tray icon doesn't decode: {e}", icon.dir())))
        .collect()
}

fn decode(png: &[u8]) -> Result<Pixmap, png::DecodingError> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(png));
    /* Palette and low bit depths up to 8 bits, 16 bits down to 8, so every PNG reads as 8-bit. */
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info()?;
    let mut buf = vec![0; reader.output_buffer_size().expect("a tray icon fits in memory")];
    let info = reader.next_frame(&mut buf)?;
    let pixels = &buf[..info.buffer_size()];
    let argb = match info.color_type {
        png::ColorType::Rgba => pixels.chunks_exact(4).flat_map(|p| [p[3], p[0], p[1], p[2]]).collect(),
        png::ColorType::Rgb => pixels.chunks_exact(3).flat_map(|p| [255, p[0], p[1], p[2]]).collect(),
        png::ColorType::GrayscaleAlpha => pixels.chunks_exact(2).flat_map(|p| [p[1], p[0], p[0], p[0]]).collect(),
        png::ColorType::Grayscale => pixels.iter().flat_map(|&g| [255, g, g, g]).collect(),
        png::ColorType::Indexed => unreachable!("EXPAND turns a palette into RGB(A)"),
    };
    Ok(Pixmap {
        width: info.width,
        height: info.height,
        argb,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_state_decodes_at_every_size() {
        for icon in Icon::ALL {
            let maps = pixmaps(icon);
            assert_eq!(maps.len(), SIZES.len());
            for (m, size) in maps.iter().zip(SIZES) {
                assert_eq!((m.width, m.height), (size, size), "{}", icon.dir());
                assert_eq!(m.argb.len() as u32, size * size * 4);
                /* Something shows. */
                assert!(m.argb.chunks_exact(4).any(|p| p[0] > 0), "{} {size}", icon.dir());
            }
        }
        /* The states differ. */
        assert_ne!(pixmaps(Icon::Idle), pixmaps(Icon::Working));
        assert_ne!(pixmaps(Icon::Working), pixmaps(Icon::Needs));
        assert_ne!(pixmaps(Icon::Idle), pixmaps(Icon::Stopped));
    }

    #[test]
    fn rgba_becomes_argb() {
        /* A 1×1 RGBA PNG, written here, of (0x11, 0x22, 0x33, 0x44). */
        let mut png = Vec::new();
        {
            let mut e = png::Encoder::new(&mut png, 1, 1);
            e.set_color(png::ColorType::Rgba);
            e.set_depth(png::BitDepth::Eight);
            e.write_header()
                .unwrap()
                .write_image_data(&[0x11, 0x22, 0x33, 0x44])
                .unwrap();
        }
        assert_eq!(
            decode(&png).unwrap(),
            Pixmap {
                width: 1,
                height: 1,
                argb: vec![0x44, 0x11, 0x22, 0x33]
            }
        );
    }
}
