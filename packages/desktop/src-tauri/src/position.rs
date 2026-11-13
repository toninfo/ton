//! Where a bubble goes: a random screen edge of the monitor under the cursor, inside its work area.
//! All values are logical pixels; callers convert with the monitor's own scale factor.

use rand::Rng;
use serde::Serialize;

pub const WIDTH: f64 = 460.0;
pub const MIN_HEIGHT: f64 = 220.0;
pub const MAX_HEIGHT: f64 = 560.0;
/// Gap between the bubble and the work-area edge once it has slid in.
pub const MARGIN: f64 = 24.0;
/// How far outside its final position the slide-in starts.
pub const SLIDE: f64 = 140.0;
/// Room on the edge side of the window for the tail that points at the screen edge.
pub const TAIL: f64 = 12.0;
const CURSOR_CLEARANCE: f64 = 80.0;

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

/// Clamp the body height so the window always fits inside the work area.
pub fn clamp_height(height: f64, work: Rect) -> f64 {
    let room = (work.h - 2.0 * MARGIN - TAIL).max(120.0);
    height.clamp(MIN_HEIGHT.min(room), MAX_HEIGHT.min(room))
}

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
        Edge::Top => (span(work.x, work.w, w), work.y + MARGIN),
        Edge::Bottom => (span(work.x, work.w, w), work.y + work.h - MARGIN - h),
        Edge::Left => (work.x + MARGIN, span(work.y, work.h, h)),
        Edge::Right => (work.x + work.w - MARGIN - w, span(work.y, work.h, h)),
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

/// Ease-out positions from `from` to `to` in `steps` moves (X11 stutters with many more).
pub fn slide_path(from: Rect, to: Rect, steps: usize) -> Vec<(f64, f64)> {
    (1..=steps)
        .map(|step| {
            let t = step as f64 / steps as f64;
            let eased = 1.0 - (1.0 - t).powi(3);
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
        assert_eq!(rect.x, -1280.0 + MARGIN);
    }

    #[test]
    fn height_is_clamped_to_small_screens() {
        let small = Rect { x: 0.0, y: 0.0, w: 1024.0, h: 400.0 };
        let height = clamp_height(560.0, small);
        assert!(height + TAIL + 2.0 * MARGIN <= 400.0);
        assert_eq!(clamp_height(100.0, WORK), MIN_HEIGHT);
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
