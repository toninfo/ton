//! Where a bubble goes: a random screen edge of the monitor under the cursor, inside its work area.
//! All values are CSS pixels, the unit the page lays itself out in and reports its height in;
//! `bubble::Screen` converts to physical pixels using the WebView's `devicePixelRatio`.

use rand::Rng;
use serde::Serialize;

pub const WIDTH: f64 = 720.0;
/// The bubble sizes itself to its content so the sheet's padding stays equal on all four sides;
/// the floor only keeps the silhouette well-formed (the tail strip plus a rounded corner).
pub const MIN_HEIGHT: f64 = 160.0;
pub const MAX_HEIGHT: f64 = 800.0;
/// Gap between the bubble and the work-area edge on the sides without the tail.
pub const MARGIN: f64 = 24.0;
/// How far outside its final position the slide-in starts.
pub const SLIDE: f64 = 140.0;
/// Room on the edge side of the window for the tail that points at the screen edge.
pub const TAIL: f64 = 30.0;
/// Base width of that tail (the page draws the same outline).
pub const TAIL_WIDTH: f64 = 54.0;
/// Radius of the tail's round tip: it ends in a cap, not a point.
pub const TAIL_CAP: f64 = 9.0;
/// How far the flanks run inwards along the body edge before they lift, so the base has no kink.
pub const TAIL_FLARE: f64 = 10.0;
/// Vertical reach of the flank's second control point above the cap start.
pub const TAIL_SHOULDER: f64 = 12.0;
/// The four constants above describe one curve; `bubble.js` draws the same outline and the XShape
/// cutter in `platform.rs` inverts the same cubic, or the drawn tail and the window cut disagree
/// and the leftover strip shows as black.
const CURSOR_CLEARANCE: f64 = 80.0;

/// The mini bubble the sheet grows out of: a small body in the sheet's own body strip, carrying the
/// same tail. `span` keeps a straight edge long enough for the whole tail base
/// (`span - 2 * radius >= TAIL_WIDTH`), so the junction has the same shape as the grown sheet's.
/// `bubble.js` mirrors these three values.
pub const MINI_SPAN: f64 = 80.0;
/// Deepest the mini body gets: the page pulses it 16 px shallower than this, never deeper, so the
/// shaped-window cut (which cannot be redrawn every frame) always covers the breathing outline.
pub const MINI_DEPTH: f64 = 72.0;
pub const MINI_RADIUS: f64 = 12.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    Top,
    Right,
    Bottom,
    Left,
}

const EDGES: [Edge; 4] = [Edge::Top, Edge::Right, Edge::Bottom, Edge::Left];

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    fn distance_to(&self, point: (f64, f64)) -> f64 {
        let dx = (self.x - point.0).max(point.0 - (self.x + self.w)).max(0.0);
        let dy = (self.y - point.1).max(point.1 - (self.y + self.h)).max(0.0);
        (dx * dx + dy * dy).sqrt()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Placement {
    pub edge: Edge,
    /// 0..1 position along the edge.
    pub along: f64,
}

impl Placement {
    /// Where the tail sits along the window side that faces the screen edge (0..1).
    pub fn tail(&self) -> f64 {
        0.2 + 0.6 * self.along
    }
}

/// Window size including the tail strip.
pub fn window_size(edge: Edge, body_height: f64) -> (f64, f64) {
    match edge {
        Edge::Top | Edge::Bottom => (WIDTH, body_height + TAIL),
        Edge::Left | Edge::Right => (WIDTH + TAIL, body_height),
    }
}

/// Where the tail sits along the window side that faces the screen edge, in CSS px, kept far
/// enough from the corners for the whole tail base. `bubble.js` and `platform.rs` clamp with the
/// same rule; the mini bubble the sheet grows out of is centred here.
pub fn tail_center(edge: Edge, size: (f64, f64), placement: Placement) -> f64 {
    let span = match edge {
        Edge::Top | Edge::Bottom => size.0,
        Edge::Left | Edge::Right => size.1,
    };
    (placement.tail() * span).clamp(TAIL_WIDTH / 2.0, span - TAIL_WIDTH / 2.0)
}

/// Clamp the body height so the window always fits inside the work area.
pub fn clamp_height(height: f64, work: Rect) -> f64 {
    let room = (work.h - TAIL - MARGIN).max(120.0);
    height.clamp(MIN_HEIGHT.min(room), MAX_HEIGHT.min(room))
}

/// The tail points at the work-area edge and its tip touches it; the other sides keep `MARGIN`.
pub fn final_rect(work: Rect, size: (f64, f64), placement: Placement) -> Rect {
    let (w, h) = size;
    let span = |start: f64, length: f64, size: f64| {
        let lo = start + MARGIN;
        let hi = start + length - MARGIN - size;
        if hi <= lo {
            start + ((length - size) / 2.0).max(0.0)
        } else {
            lo + placement.along.clamp(0.0, 1.0) * (hi - lo)
        }
    };
    let (x, y) = match placement.edge {
        Edge::Top => (span(work.x, work.w, w), work.y),
        Edge::Bottom => (span(work.x, work.w, w), work.y + work.h - h),
        Edge::Left => (work.x, span(work.y, work.h, h)),
        Edge::Right => (work.x + work.w - w, span(work.y, work.h, h)),
    };
    Rect { x, y, w, h }
}

/// The tail centre of `rect`, as a screen coordinate along the screen edge it points at.
pub fn tail_screen(rect: Rect, placement: Placement) -> f64 {
    let center = tail_center(placement.edge, (rect.w, rect.h), placement);
    match placement.edge {
        Edge::Top | Edge::Bottom => rect.x + center,
        Edge::Left | Edge::Right => rect.y + center,
    }
}

/// `final_rect`, but with the tail tip pinned to `tail` (a screen coordinate along the edge): the
/// breathing bubble and the sheet it grows into keep one tail spot while the body height settles,
/// so nothing slides out from under the pointer when the content arrives.
pub fn place(work: Rect, size: (f64, f64), placement: Placement, tail: f64) -> Rect {
    let (w, h) = size;
    let (start, length, span) = match placement.edge {
        Edge::Top | Edge::Bottom => (work.x, work.w, w),
        Edge::Left | Edge::Right => (work.y, work.h, h),
    };
    let lo = start + MARGIN;
    let hi = start + length - MARGIN - span;
    let along = if hi <= lo {
        start + ((length - span) / 2.0).max(0.0)
    } else {
        (tail - tail_center(placement.edge, size, placement)).clamp(lo, hi)
    };
    let (x, y) = match placement.edge {
        Edge::Top => (along, work.y),
        Edge::Bottom => (along, work.y + work.h - h),
        Edge::Left => (work.x, along),
        Edge::Right => (work.x + work.w - w, along),
    };
    Rect { x, y, w, h }
}

/// The same rectangle pushed `SLIDE` px towards (and past) its screen edge.
pub fn start_rect(target: Rect, edge: Edge) -> Rect {
    let (dx, dy) = match edge {
        Edge::Top => (0.0, -SLIDE),
        Edge::Bottom => (0.0, SLIDE),
        Edge::Left => (-SLIDE, 0.0),
        Edge::Right => (SLIDE, 0.0),
    };
    Rect { x: target.x + dx, y: target.y + dy, ..target }
}

/// Random edge (never `last_edge` twice in a row) and offset, keeping clear of the cursor.
pub fn choose<R: Rng>(
    rng: &mut R,
    work: Rect,
    body_height: f64,
    cursor: Option<(f64, f64)>,
    last_edge: Option<Edge>,
) -> Placement {
    let edges: Vec<Edge> = EDGES.iter().copied().filter(|edge| Some(*edge) != last_edge).collect();
    let mut fallback = None;
    for _ in 0..16 {
        let placement = Placement {
            edge: edges[rng.gen_range(0..edges.len())],
            along: rng.gen_range(0.05..0.95),
        };
        let rect = final_rect(work, window_size(placement.edge, body_height), placement);
        match cursor {
            Some(point) if rect.distance_to(point) < CURSOR_CLEARANCE => {
                fallback.get_or_insert(placement);
            }
            _ => return placement,
        }
    }
    fallback.unwrap_or(Placement { edge: edges[0], along: 0.5 })
}

/// Ease-out cubic for the slide; a linear window move reads as a jump.
pub fn ease(t: f64) -> f64 {
    1.0 - (1.0 - t).powi(3)
}

/// Ease-out positions from `from` to `to` in `steps` moves (X11 stutters with many more).
pub fn slide_path(from: Rect, to: Rect, steps: usize) -> Vec<(f64, f64)> {
    (1..=steps)
        .map(|step| {
            let eased = ease(step as f64 / steps as f64);
            (from.x + (to.x - from.x) * eased, from.y + (to.y - from.y) * eased)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::mock::StepRng;
    use rand::SeedableRng;

    const WORK: Rect = Rect { x: 0.0, y: 0.0, w: 1920.0, h: 1050.0 };

    fn inside(rect: Rect, work: Rect) -> bool {
        rect.x >= work.x && rect.y >= work.y && rect.x + rect.w <= work.x + work.w && rect.y + rect.h <= work.y + work.h
    }

    #[test]
    fn final_rect_stays_in_work_area_for_every_edge() {
        for edge in EDGES {
            for along in [0.0, 0.5, 1.0] {
                let placement = Placement { edge, along };
                let rect = final_rect(WORK, window_size(edge, 560.0), placement);
                assert!(inside(rect, WORK), "{edge:?} {along} {rect:?}");
            }
        }
    }

    #[test]
    fn negative_monitor_coordinates_are_fine() {
        let left = Rect { x: -1280.0, y: -200.0, w: 1280.0, h: 1000.0 };
        let rect = final_rect(left, window_size(Edge::Left, 300.0), Placement { edge: Edge::Left, along: 0.3 });
        assert!(inside(rect, left));
        assert_eq!(rect.x, -1280.0);
    }

    #[test]
    fn tail_tip_touches_the_edge() {
        for edge in EDGES {
            let rect = final_rect(WORK, window_size(edge, 560.0), Placement { edge, along: 0.5 });
            match edge {
                Edge::Top => assert_eq!(rect.y, WORK.y),
                Edge::Bottom => assert_eq!(rect.y + rect.h, WORK.y + WORK.h),
                Edge::Left => assert_eq!(rect.x, WORK.x),
                Edge::Right => assert_eq!(rect.x + rect.w, WORK.x + WORK.w),
            }
        }
    }

    #[test]
    fn height_is_clamped_to_small_screens() {
        let small = Rect { x: 0.0, y: 0.0, w: 1024.0, h: 400.0 };
        let height = clamp_height(560.0, small);
        assert!(height + TAIL + MARGIN <= 400.0);
        assert_eq!(clamp_height(100.0, WORK), MIN_HEIGHT);
    }

    #[test]
    fn the_tail_stays_put_when_the_body_height_changes() {
        for edge in EDGES {
            let placement = Placement { edge, along: 0.2 };
            let first = final_rect(WORK, window_size(edge, 460.0), placement);
            let tail = tail_screen(first, placement);
            for height in [160.0, 300.0, 460.0, 700.0] {
                let rect = place(WORK, window_size(edge, height), placement, tail);
                assert!(inside(rect, WORK), "{edge:?} {height} {rect:?}");
                let moved = (tail_screen(rect, placement) - tail).abs();
                // Clamping only bites where the anchor would push the window past a margin.
                let span = match edge {
                    Edge::Top | Edge::Bottom => rect.w,
                    Edge::Left | Edge::Right => rect.h,
                };
                let center = tail_center(edge, (rect.w, rect.h), placement);
                let room = match edge {
                    Edge::Top | Edge::Bottom => (WORK.x + MARGIN, WORK.x + WORK.w - MARGIN - span),
                    Edge::Left | Edge::Right => (WORK.y + MARGIN, WORK.y + WORK.h - MARGIN - span),
                };
                if (tail - center) > room.0 && (tail - center) < room.1 {
                    assert!(moved < 0.001, "{edge:?} {height} moved {moved}");
                }
            }
        }
    }

    #[test]
    fn never_the_same_edge_twice_and_away_from_cursor() {
        let mut rng = rand::rngs::StdRng::seed_from_u64(7);
        for _ in 0..200 {
            let placement = choose(&mut rng, WORK, 300.0, Some((960.0, 30.0)), Some(Edge::Bottom));
            assert_ne!(placement.edge, Edge::Bottom);
            let rect = final_rect(WORK, window_size(placement.edge, 300.0), placement);
            assert!(rect.distance_to((960.0, 30.0)) >= CURSOR_CLEARANCE);
        }
    }

    #[test]
    fn falls_back_when_the_cursor_blocks_everything() {
        let tiny = Rect { x: 0.0, y: 0.0, w: 520.0, h: 320.0 };
        let mut rng = StepRng::new(0, 1);
        let placement = choose(&mut rng, tiny, 220.0, Some((260.0, 160.0)), None);
        assert!(placement.along >= 0.0);
    }

    #[test]
    fn slide_starts_outside_and_ends_on_target() {
        let target = final_rect(WORK, window_size(Edge::Right, 300.0), Placement { edge: Edge::Right, along: 0.5 });
        let start = start_rect(target, Edge::Right);
        assert_eq!(start.x, target.x + SLIDE);
        let path = slide_path(start, target, 12);
        assert_eq!(path.len(), 12);
        assert_eq!(*path.last().unwrap(), (target.x, target.y));
    }
}
