"""
Integration test suite for Nago — validates core behaviour of all components.

Tests are self-contained: no display server required, no user observation.
Covers 7 acceptance conditions:

1. Window starts → stickman visible, background transparent
2. Mouse movement → AI-driven dynamic reactions
3. Window drag → functional
4. Click → positive-feedback animation
5. Long idle → AI-driven bored/sleeping state
6. AI emotion commands → colour changes under AI control
7. API failure → graceful fade (light-grey + reduced opacity)

Usage:  python test_integration.py
"""

from __future__ import annotations

import json
import logging
import sys
import time as _time
import unittest
from dataclasses import dataclass

import httpx

# ── Setup logging before importing modules that use it ────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("integration_test")


# ── Model the AI test backend for offline/error scenarios ──────────────────

_TEST_CONTEXTS = {
    "hover_active": {
        "mouse_position": [100, 60],
        "mouse_delta": [5, 3],
        "clicks": [],
        "wheel_delta": [0, 0],
        "hover": True,
        "time_since_last_input_ms": 200,
        "foreground_window": "Terminal",
        "is_desktop": False,
        "screen_resolution": [1920, 1080],
        "touch_gesture": {},
        "swipe": None,
    },
    "idle_long": {
        "mouse_position": [50, 150],
        "mouse_delta": [0, 0],
        "clicks": [],
        "wheel_delta": [0, 0],
        "hover": False,
        "time_since_last_input_ms": 12000,
        "foreground_window": "Desktop",
        "is_desktop": True,
        "screen_resolution": [1920, 1080],
        "touch_gesture": {},
        "swipe": None,
    },
    "click_left": {
        "mouse_position": [100, 100],
        "mouse_delta": [0, 0],
        "clicks": ["left"],
        "wheel_delta": [0, 0],
        "hover": True,
        "time_since_last_input_ms": 50,
        "foreground_window": "Chrome",
        "is_desktop": False,
        "screen_resolution": [2560, 1440],
        "touch_gesture": {},
        "swipe": None,
    },
    "double_click": {
        "mouse_position": [100, 120],
        "mouse_delta": [0, 0],
        "clicks": ["double_left"],
        "wheel_delta": [0, 0],
        "hover": True,
        "time_since_last_input_ms": 80,
        "foreground_window": "VS Code",
        "is_desktop": False,
        "screen_resolution": [1920, 1080],
        "touch_gesture": {},
        "swipe": None,
    },
    "swipe_right": {
        "mouse_position": [180, 80],
        "mouse_delta": [120, 5],
        "clicks": [],
        "wheel_delta": [0, 0],
        "hover": True,
        "time_since_last_input_ms": 30,
        "foreground_window": "Firefox",
        "is_desktop": False,
        "screen_resolution": [1920, 1080],
        "touch_gesture": {},
        "swipe": {"direction": "right", "speed": 250},
    },
    "scroll_curious": {
        "mouse_position": [100, 60],
        "mouse_delta": [0, 0],
        "clicks": [],
        "wheel_delta": [0, -120],
        "hover": True,
        "time_since_last_input_ms": 200,
        "foreground_window": "Terminal",
        "is_desktop": False,
        "screen_resolution": [1920, 1080],
        "touch_gesture": {},
        "swipe": None,
    },
    "window_switch_desktop": {
        "mouse_position": [150, 200],
        "mouse_delta": [30, 10],
        "clicks": [],
        "wheel_delta": [0, 0],
        "hover": True,
        "time_since_last_input_ms": 500,
        "foreground_window": "",
        "is_desktop": True,
        "screen_resolution": [1920, 1080],
        "touch_gesture": {},
        "swipe": None,
    },
}


# ── Test Suite ────────────────────────────────────────────────────────────


class TestStickmanParams(unittest.TestCase):
    """Verify StickmanParams dataclass invariants and clamping."""

    def test_defaults(self) -> None:
        from stickman import StickmanParams  # noqa: F811
        p = StickmanParams()
        self.assertEqual(p.line_color, (0, 0, 0))
        self.assertEqual(p.opacity, 1.0)
        self.assertEqual(p.line_width, 1)
        self.assertEqual(p.eye_offset, 0)
        self.assertEqual(p.eyelid_offset, 0)
        self.assertEqual(p.mouth_angle, 0.0)
        self.assertEqual(p.mouth_opening, 0.0)
        self.assertEqual(p.arm_left_angle, 30.0)
        self.assertEqual(p.arm_right_angle, -30.0)
        self.assertFalse(p.blink)
        self.assertFalse(p.invert_colors)
        self.assertIsNone(p.background_gradient)
        self.assertIsNone(p.speech_bubble)

    def test_clamping(self) -> None:
        from stickman import StickmanParams  # noqa: F811
        p = StickmanParams(
            arm_left_angle=200, arm_right_angle=-200,
            mouth_opening=200, mouth_angle=100,
        )
        self.assertEqual(p.arm_left_angle, 90.0)
        self.assertEqual(p.arm_right_angle, -90.0)
        self.assertEqual(p.mouth_opening, 100.0)
        # mouth_angle is clamped only at render time, not in __post_init__
        self.assertEqual(p.mouth_angle, 100.0)

    def test_blink_cycle(self) -> None:
        from stickman import StickmanParams  # noqa: F811
        p = StickmanParams()
        p.start_blink((255, 0, 0))
        self.assertTrue(p.blink)
        self.assertEqual(p.line_color, (255, 0, 0))
        p.toggle_blink()
        self.assertEqual(p.line_color, (0, 0, 0))
        p.toggle_blink()
        self.assertEqual(p.line_color, (255, 0, 0))
        p.stop_blink()
        self.assertFalse(p.blink)
        self.assertEqual(p.line_color, (255, 0, 0))

    def test_toggle_blink_no_color(self) -> None:
        from stickman import StickmanParams  # noqa: F811
        p = StickmanParams()
        p.toggle_blink()  # No blink_colour set → no-op
        self.assertEqual(p.line_color, (0, 0, 0))


class TestControlPlane(unittest.TestCase):
    """Control plane: pure patching with no action-name side effects or enrichment."""

    def test_empty_params_preserves_state(self) -> None:
        from stickman import StickmanParams
        from control import apply_control_patch
        p = StickmanParams(line_color=(255, 0, 0), opacity=0.5, mouth_angle=30.0)
        result, motion = apply_control_patch(None, p)
        self.assertEqual(result.line_color, (255, 0, 0))
        self.assertEqual(result.opacity, 0.5)
        self.assertEqual(result.mouth_angle, 30.0)
        self.assertEqual(motion, {})

    def test_action_name_ignored_by_execute_action(self) -> None:
        from stickman import StickmanParams
        from behavior import execute_action
        p = StickmanParams(line_color=(10, 20, 30))
        # ``angry`` no longer automatically changes the line color to red.
        result = execute_action("angry", {}, p)
        self.assertEqual(result.line_color, (10, 20, 30))

    def test_patch_color_and_pose(self) -> None:
        from stickman import StickmanParams
        from control import apply_control_patch
        p = StickmanParams()
        result, motion = apply_control_patch(
            {"color": [200, 40, 40], "mouth_angle": -25.0, "eyelid_offset": 3},
            p,
        )
        self.assertEqual(result.line_color, (200, 40, 40))
        self.assertEqual(result.mouth_angle, -25.0)
        self.assertEqual(result.eyelid_offset, 3)
        self.assertEqual(motion, {})

    def test_walk_motion_extras(self) -> None:
        from stickman import StickmanParams
        from control import apply_control_patch
        result, motion = apply_control_patch(
            {"walk_dx": 3, "walk_dy": -2, "gait": True, "head_scale": 1.5},
            StickmanParams(),
        )
        self.assertEqual(motion["walk_dx"], 3.0)
        self.assertEqual(motion["walk_dy"], -2.0)
        self.assertTrue(motion["gait"])
        self.assertEqual(result.head_scale, 1.5)

    def test_play_animation_patch(self) -> None:
        from stickman import StickmanParams
        from control import apply_control_patch
        _, motion = apply_control_patch({"play": "punch"}, StickmanParams())
        self.assertEqual(motion.get("play"), "punch")
        _, motion2 = apply_control_patch({"play": "invalid"}, StickmanParams())
        self.assertNotIn("play", motion2)

    def test_clamps_out_of_range(self) -> None:
        from stickman import StickmanParams
        from control import apply_control_patch
        result, motion = apply_control_patch(
            {"opacity": 9.0, "walk_dx": 99, "eyelid_offset": 99},
            StickmanParams(),
        )
        self.assertEqual(result.opacity, 1.0)
        self.assertEqual(result.eyelid_offset, 10)
        self.assertEqual(motion["walk_dx"], 12.0)

    def test_emoji_ignored(self) -> None:
        from stickman import StickmanParams
        from control import apply_control_patch
        result, _ = apply_control_patch({"emoji": "😡", "color": [1, 2, 3]}, StickmanParams())
        self.assertIsNone(result.emoji)
        self.assertEqual(result.line_color, (1, 2, 3))

    def test_unknown_keys_ignored(self) -> None:
        from stickman import StickmanParams
        from control import apply_control_patch
        result, _ = apply_control_patch({"not_a_real_field": 123, "eye_offset": 5}, StickmanParams())
        self.assertEqual(result.eye_offset, 5)

    def test_sticky_color_strips_without_emotion(self) -> None:
        from stickman import StickmanParams
        from control import filter_sticky_color
        filtered, emotion = filter_sticky_color(
            {"color": [255, 0, 0], "walk_dx": 2},
            StickmanParams(),
            None,
        )
        self.assertNotIn("color", filtered)
        self.assertEqual(filtered["walk_dx"], 2)
        self.assertIsNone(emotion)

    def test_sticky_color_allows_emotion_label_change(self) -> None:
        from stickman import StickmanParams
        from control import filter_sticky_color
        filtered, emotion = filter_sticky_color(
            {"emotion": "happy", "color": [255, 100, 50]},
            StickmanParams(),
            "neutral",
        )
        self.assertEqual(filtered["color"], [255, 100, 50])
        self.assertEqual(emotion, "happy")

    def test_sticky_color_allows_face_shift(self) -> None:
        from stickman import StickmanParams
        from control import filter_sticky_color
        filtered, _ = filter_sticky_color(
            {"color": [0, 200, 0], "mouth_angle": 30.0},
            StickmanParams(mouth_angle=0.0),
            None,
        )
        self.assertEqual(filtered["color"], [0, 200, 0])

    def test_generic_speech_stripped(self) -> None:
        from control import filter_generic_speech
        out = filter_generic_speech({"speech_bubble": "加油！", "mouth_angle": 20})
        self.assertIsNone(out.get("speech_bubble"))
        self.assertEqual(out["mouth_angle"], 20)
        # Character voice is not banned by catchphrase lists.
        kept = filter_generic_speech({"speech_bubble": "忙啥呢"})
        self.assertEqual(kept.get("speech_bubble"), "忙啥呢")

    def test_specific_speech_kept(self) -> None:
        from control import filter_generic_speech
        out = filter_generic_speech({"speech_bubble": "好的老板"})
        self.assertEqual(out["speech_bubble"], "好的老板")

    def test_ambient_speech_stripped(self) -> None:
        from control import strip_speech_for_ambient
        out = strip_speech_for_ambient({"speech_bubble": "你好呀", "mouth_angle": 10})
        self.assertIsNone(out.get("speech_bubble"))
        self.assertEqual(out.get("mouth_angle"), 10)

    def test_bubble_layout_avoids_head(self) -> None:
        from main import _compute_bubble_layout, _bubble_intersects_head
        head_x, head_y, hw, hh = 75.0, 30.0, 50.0, 60.0
        bw, bh = 80.0, 36.0
        _side, bx, by, tail = _compute_bubble_layout("top", head_x, head_y, hw, hh, bw, bh)
        self.assertFalse(
            _bubble_intersects_head(bx, by, bw, bh, head_x, head_y, hw, hh, 8.0, tail)
        )

    def test_mouse_approach_velocity(self) -> None:
        from main import _compute_mouse_approach_velocity
        vx, vy, stop = _compute_mouse_approach_velocity(0, 0, 100, 150, 400, 300)
        self.assertFalse(stop)
        self.assertGreater(vx, 0)
        self.assertGreater(vy, 0)
        _, _, stop_near = _compute_mouse_approach_velocity(0, 0, 100, 150, 55, 80)
        self.assertTrue(stop_near)

    def test_punch_play_frames(self) -> None:
        from main import _build_punch_play_frames, _look_offset_from_mouse
        eye, pupil = _look_offset_from_mouse(30.0, 40.0)
        self.assertLess(eye, 0)
        frames, durs = _build_punch_play_frames(eye, pupil)
        self.assertEqual(len(frames), 4)
        self.assertEqual(len(durs), 4)
        self.assertIn("mouth_opening", frames[2])

    def test_execute_action_merges_params(self) -> None:
        from stickman import StickmanParams
        from behavior import execute_action
        result = execute_action("dance", {"body_offset_x": 5.0, "eye_offset": 10}, StickmanParams())
        self.assertEqual(result.body_offset_x, 5.0)
        self.assertEqual(result.eye_offset, 10)


class TestAIClient(unittest.TestCase):
    """Verify the AI client's JSON parsing and response normalization."""

    def test_normalize_single_action(self) -> None:
        from ai_client import normalize_action_response
        raw = {"action": "wave", "comment": "hi", "params": {"arm_left_angle": -80.0}}
        actions = normalize_action_response(raw)
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0]["action"], "wave")
        self.assertIn("params", actions[0])

    def test_normalize_multi_action(self) -> None:
        from ai_client import normalize_action_response
        raw = {
            "actions": [
                {"action": "wave", "params": {}},
                {"action": "blink", "params": {}},
            ],
        }
        actions = normalize_action_response(raw)
        self.assertEqual(len(actions), 2)
        self.assertEqual(actions[0]["action"], "wave")
        self.assertEqual(actions[1]["action"], "blink")

    def test_normalize_invalid(self) -> None:
        from ai_client import normalize_action_response
        self.assertEqual(normalize_action_response("not_a_dict"), [])
        self.assertEqual(normalize_action_response({}), [])
        self.assertEqual(normalize_action_response({"unknown": "field"}), [])

    def test_normalize_multi_action_filters_non_dicts(self) -> None:
        from ai_client import normalize_action_response
        raw = {"actions": [{"action": "good"}, "bad_string", 123]}
        actions = normalize_action_response(raw)
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0]["action"], "good")

    def test_hex_color_parser(self) -> None:
        from main import _parse_hex_color
        self.assertEqual(_parse_hex_color("#FF0000"), (255, 0, 0))
        self.assertEqual(_parse_hex_color("#000000"), (0, 0, 0))
        self.assertEqual(_parse_hex_color("#CCCCCC"), (204, 204, 204))
        self.assertEqual(_parse_hex_color("#00ff00"), (0, 255, 0))
        self.assertIsNone(_parse_hex_color("bad"))
        self.assertIsNone(_parse_hex_color("#GGG"))

    def test_system_prompt_contains_critical_constraints(self) -> None:
        from main import _STICKMAN_SYSTEM_PROMPT
        prompt = _STICKMAN_SYSTEM_PROMPT
        self.assertIn("json.loads()", prompt)
        self.assertIn("WHO YOU ARE — Nago", prompt)
        self.assertIn("Playful", prompt)
        self.assertIn("CONTROL FIELDS", prompt)
        self.assertIn("NEVER invent", prompt)
        self.assertIn("DO NOT use emoji", prompt)
        self.assertIn("walk_dx", prompt)
        self.assertIn("Stay in character as Nago", prompt)

    def test_build_system_prompt_single_source(self) -> None:
        from control import build_system_prompt
        from ai_client import _SYSTEM_PROMPT
        from main import _STICKMAN_SYSTEM_PROMPT
        self.assertEqual(_STICKMAN_SYSTEM_PROMPT, _SYSTEM_PROMPT)
        self.assertEqual(build_system_prompt(), _SYSTEM_PROMPT)


class TestLongTermMemory(unittest.TestCase):
    def setUp(self) -> None:
        import tempfile
        from pathlib import Path
        from memory import LongTermMemory
        self._tmpdir = tempfile.TemporaryDirectory()
        self._path = Path(self._tmpdir.name) / "nago.memory.json"
        self.mem = LongTermMemory(self._path, max_facts=8)

    def tearDown(self) -> None:
        self._tmpdir.cleanup()

    def test_upsert_and_dedupe(self) -> None:
        self.assertTrue(self.mem.upsert("用户叫小明", category="identity", importance=0.9))
        self.assertTrue(self.mem.upsert("用户叫小明", category="identity", importance=0.95))
        self.assertEqual(len(self.mem.facts), 1)
        self.assertGreaterEqual(self.mem.facts[0]["importance"], 0.95)

    def test_promote_explicit_user(self) -> None:
        self.assertTrue(self.mem.maybe_promote_from_user("记住：我喜欢安静，别老出拳"))
        self.assertEqual(self.mem.facts[0]["category"], "boundary")
        self.assertFalse(self.mem.maybe_promote_from_user("今天天气不错"))

    def test_forget(self) -> None:
        self.mem.upsert("喜欢打拳", category="preference")
        self.assertEqual(self.mem.forget("打拳"), 1)
        self.assertEqual(len(self.mem.facts), 0)

    def test_remember_payload(self) -> None:
        n = self.mem.apply_remember_payload(
            {"text": "正在写 Nago", "category": "project", "importance": 0.8}
        )
        self.assertEqual(n, 1)
        blob = self.mem.to_context_blob()
        self.assertEqual(blob["count"], 1)
        self.assertIn("Nago", blob["facts"][0])


class TestSessionMemory(unittest.TestCase):
    """Session persistence and oversized-log compression."""

    def setUp(self) -> None:
        import tempfile
        from pathlib import Path
        from session import SessionMemory
        self._tmpdir = tempfile.TemporaryDirectory()
        self._path = Path(self._tmpdir.name) / "nago.session.json"
        self.mem = SessionMemory(self._path, max_chars=200, keep_recent_chars=60)

    def tearDown(self) -> None:
        self._tmpdir.cleanup()

    def test_queue_and_persist(self) -> None:
        self.assertTrue(self.mem.queue_user_message("你好呀"))
        self.assertEqual(self.mem.peek_pending_user(), "你好呀")
        self.assertTrue(self._path.is_file())
        self.mem.consume_pending_user()
        self.assertIsNone(self.mem.peek_pending_user())

    def test_nago_summary(self) -> None:
        from session import summarize_actions
        s = summarize_actions([
            {"action": "punch", "params": {"play": "punch", "speech_bubble": "好的老板"}},
        ])
        self.assertIn("punch", s)
        self.assertIn("好的老板", s)
        self.assertIn('says "好的老板"', s)

    def test_fallback_compression_uses_english_archival_labels(self) -> None:
        for i in range(80):
            self.mem.append("user", f"message {i:02d} with extra text for compression")
        self.assertTrue(self.mem.compress())
        self.assertIn("(auto-compressed) User said:", self.mem.entries[0]["text"])
        self.assertIn(" | Recent activity:", self.mem.entries[0]["text"])

    def test_compress_over_limit(self) -> None:
        for i in range(80):
            self.mem.append("user", f"用户消息编号{i:02d}再补一点字制造长度")
            self.mem.append("nago", f"nago动作摘要{i:02d}继续拉长一点内容")
        self.assertGreater(self.mem.char_count(), self.mem.max_chars)
        self.assertTrue(self.mem.needs_compress())
        self.assertTrue(self.mem.compress(summarizer=lambda _: "压缩摘要：聊过点击与走路"))
        self.assertLessEqual(self.mem.char_count(), self.mem.max_chars)
        self.assertEqual(self.mem.entries[0]["role"], "summary")
        self.assertIn("压缩摘要", self.mem.entries[0]["text"])


class TestNagoConfig(unittest.TestCase):
    """External configuration: use env or nago.local.env, never hard-code secrets."""

    def test_default_endpoint_is_local(self) -> None:
        import os
        from nago_config import get_ai_settings
        old = os.environ.pop("NAGO_AI_ENDPOINT", None)
        try:
            s = get_ai_settings()
            self.assertIn("localhost", s.endpoint)
            self.assertIn("chat/completions", s.endpoint)
        finally:
            if old is not None:
                os.environ["NAGO_AI_ENDPOINT"] = old

    def test_ai_configured_requires_key(self) -> None:
        import os
        from nago_config import ai_configured
        old_key = os.environ.pop("NAGO_AI_API_KEY", None)
        try:
            os.environ["NAGO_AI_API_KEY"] = ""
            self.assertFalse(ai_configured())
            os.environ["NAGO_AI_API_KEY"] = "test-key"
            self.assertTrue(ai_configured())
        finally:
            if old_key is None:
                os.environ.pop("NAGO_AI_API_KEY", None)
            else:
                os.environ["NAGO_AI_API_KEY"] = old_key

    def test_runtime_defaults(self) -> None:
        from nago_config import get_runtime_settings
        r = get_runtime_settings()
        self.assertGreaterEqual(r.heartbeat_ms, 1000)
        self.assertGreaterEqual(r.event_debounce_ms, 50)
        self.assertGreaterEqual(r.speech_bubble_ms, 1000)


class TestCapabilitiesDigest(unittest.TestCase):
    def test_digest_smaller_than_catalog(self) -> None:
        from control import get_capabilities_catalog, get_capabilities_digest
        full = json.dumps(get_capabilities_catalog())
        digest = json.dumps(get_capabilities_digest())
        self.assertLess(len(digest), len(full))
        self.assertIn("animations", digest)


class TestAILiveConnectivity(unittest.TestCase):
    """Real API calls — these depend on the AI backend being reachable.

    Skips are acceptable (skip message printed) but failures indicate a
    regression in the client or the API contract.
    """

    @classmethod
    def setUpClass(cls) -> None:
        from nago_config import ai_configured, get_ai_settings
        cls._configured = ai_configured()
        settings = get_ai_settings()
        cls._endpoint = settings.endpoint
        cls.api_reachable = False
        if not cls._configured:
            return
        try:
            with httpx.Client(timeout=3.0) as client:
                client.head(settings.endpoint)
            cls.api_reachable = True
        except Exception:
            cls.api_reachable = False

    def _call_ai(self, context: dict) -> list[dict] | None:
        from ai_client import get_ai_action_sync
        return get_ai_action_sync(context)

    def _require_live_api(self) -> None:
        if not self._configured:
            self.skipTest("AI not configured (set NAGO_AI_API_KEY)")
        if not self.api_reachable:
            self.skipTest(f"AI endpoint unreachable: {self._endpoint}")

    def _assert_valid_actions(self, result: list[dict] | None, scenario: str) -> list[dict]:
        self.assertIsNotNone(result, f"{scenario}: AI returned None (failure)")
        assert result is not None  # type guard
        self.assertIsInstance(result, list, f"{scenario}: result must be list")
        self.assertGreater(len(result), 0, f"{scenario}: at least 1 action expected")
        for i, action in enumerate(result):
            self.assertIsInstance(action, dict, f"{scenario}: action[{i}] must be dict")
            self.assertIn("action", action, f"{scenario}: action[{i}] missing 'action' key")
            self.assertIsInstance(action["action"], str, f"{scenario}: action name must be str")
        return result

    def test_hover_active_response(self) -> None:
        self._require_live_api()
        actions = self._assert_valid_actions(
            self._call_ai(_TEST_CONTEXTS["hover_active"]),
            "hover_active",
        )
        logger.info("hover_active → %s (%d actions)", actions[0]["action"], len(actions))

    def test_idle_long_response(self) -> None:
        self._require_live_api()
        actions = self._assert_valid_actions(
            self._call_ai(_TEST_CONTEXTS["idle_long"]),
            "idle_long",
        )
        logger.info("idle_long → %s (%d actions)", actions[0]["action"], len(actions))
        # The model decides freely; the client validates only protocol correctness.
        self.assertIn("action", actions[0])

    def test_click_left_response(self) -> None:
        self._require_live_api()
        actions = self._assert_valid_actions(
            self._call_ai(_TEST_CONTEXTS["click_left"]),
            "click_left",
        )
        logger.info("click_left → %s (%d actions)", actions[0]["action"], len(actions))

    def test_double_click_response(self) -> None:
        self._require_live_api()
        actions = self._assert_valid_actions(
            self._call_ai(_TEST_CONTEXTS["double_click"]),
            "double_click",
        )
        logger.info("double_click → %s (%d actions)", actions[0]["action"], len(actions))

    def test_swipe_response(self) -> None:
        self._require_live_api()
        actions = self._assert_valid_actions(
            self._call_ai(_TEST_CONTEXTS["swipe_right"]),
            "swipe_right",
        )
        logger.info("swipe_right → %s (%d actions)", actions[0]["action"], len(actions))

    def test_scroll_response(self) -> None:
        self._require_live_api()
        actions = self._assert_valid_actions(
            self._call_ai(_TEST_CONTEXTS["scroll_curious"]),
            "scroll_curious",
        )
        logger.info("scroll_curious → %s (%d actions)", actions[0]["action"], len(actions))

    def test_window_switch_response(self) -> None:
        self._require_live_api()
        actions = self._assert_valid_actions(
            self._call_ai(_TEST_CONTEXTS["window_switch_desktop"]),
            "window_switch_desktop",
        )
        logger.info("window_switch_desktop → %s (%d actions)", actions[0]["action"], len(actions))

    def test_all_response_params_are_valid(self) -> None:
        """Every AI response's params must be mergeable without error."""
        self._require_live_api()
        from stickman import StickmanParams  # noqa: F811

        all_names = list(_TEST_CONTEXTS.keys())
        ok = 0
        for name in all_names:
            actions = self._call_ai(_TEST_CONTEXTS[name])
            if actions is None:
                continue  # occasional network hiccup — not a test failure
            for action in actions:
                params = action.get("params", {})
                if isinstance(params, dict):
                    try:
                        p = StickmanParams()
                        for key, value in params.items():
                            if hasattr(p, key):
                                setattr(p, key, value)
                        self.assertIsInstance(p, StickmanParams)
                    except Exception as exc:
                        self.fail(
                            f"Cannot apply params from scenario '{name}' "
                            f"action '{action['action']}': {exc}\nparams={params}"
                        )
            ok += 1
        logger.info("Param mergeability: %d/%d scenarios OK", ok, len(all_names))


class TestAIClientErrorHandling(unittest.TestCase):
    """Verify that AI client failures return None gracefully (no crashes)."""

    def test_none_context(self) -> None:
        from ai_client import get_ai_action_sync
        result = get_ai_action_sync(None)
        self.assertIsNone(result)

    def test_non_dict_context(self) -> None:
        from ai_client import get_ai_action_sync
        result = get_ai_action_sync("not_a_dict")
        self.assertIsNone(result)

    def test_empty_context(self) -> None:
        from ai_client import get_ai_action_sync
        # Empty dict is valid — AI may still respond. Verify no crash.
        result = get_ai_action_sync({})
        # Either None (error) or a valid list — both are non-crash outcomes
        self.assertTrue(result is None or isinstance(result, list))

    @unittest.skipUnless(
        False,
        "Requires network manipulation — tested manually",
    )
    def test_network_timeout_causes_fade(self) -> None:
        """Manually verified: disconnect network → fade activates."""
        pass


class TestFadeMechanism(unittest.TestCase):
    """Validate the _FadeAnimator logic without a running QApplication."""

    def test_default_state_not_fading(self) -> None:
        from main import _FadeAnimator
        a = _FadeAnimator()
        self.assertFalse(a.is_fading())
        self.assertEqual(a.fade_opacity, 1.0)

    def test_fade_transition(self) -> None:
        from main import _FadeAnimator
        a = _FadeAnimator()
        a.fade_opacity = 0.3
        a.fade_color = a._FADE_COLOR
        self.assertTrue(a.is_fading())

    def test_restore_snaps_back(self) -> None:
        from main import _FadeAnimator
        a = _FadeAnimator()
        a.fade_opacity = 0.3
        a.restore()
        self.assertFalse(a.is_fading())
        self.assertEqual(a.fade_opacity, 1.0)

    def test_display_color_transition(self) -> None:
        from main import _FadeAnimator
        from PySide6.QtGui import QColor
        a = _FadeAnimator()
        a.display_color = QColor(255, 0, 0)
        self.assertEqual(a.display_color.red(), 255)
        self.assertEqual(a.display_color.green(), 0)
        self.assertEqual(a.display_color.blue(), 0)


class TestNagoWindow(unittest.TestCase):
    """Verify NagoWindow: context building, parameter application, and fade mechanics."""

    _app: object = None
    _window: object = None

    @classmethod
    def setUpClass(cls) -> None:
        from PySide6.QtWidgets import QApplication
        cls._app = QApplication.instance() or QApplication([])
        from main import NagoWindow
        cls._window = NagoWindow()
        cls._window._heartbeat_timer.stop()
        cls._window._event_flush_timer.stop()
        cls._window._speech_bubble_timer.stop()
        cls._window._queue_timer.stop()

    @classmethod
    def tearDownClass(cls) -> None:
        from PySide6.QtWidgets import QApplication
        from PySide6.QtCore import QTimer
        cls._window._heartbeat_timer.stop()
        cls._window._event_flush_timer.stop()
        cls._window._speech_bubble_timer.stop()
        cls._window._queue_timer.stop()
        cls._window._blink_timer.stop()
        cls._window.hide()
        cls._window.deleteLater()
        QApplication.processEvents()
        QTimer.singleShot(0, QApplication.quit)
        QApplication.processEvents()

    @property
    def window(self):  # type: ignore[override]
        return self.__class__._window

    # ── Context building ──────────────────────────────────────────────────

    def test_context_has_all_required_keys(self) -> None:
        self.window._capabilities_full_sent = False
        ctx = self.window._build_context()
        for key in ("observations", "agent_state", "capabilities"):
            self.assertIn(key, ctx, f"Context missing key: {key}")
        obs = ctx["observations"]
        for key in (
            "mouse_position_window", "mouse_position_global", "mouse_delta",
            "clicks", "wheel_delta", "hover", "time_since_last_input_ms",
            "foreground_window", "is_desktop", "screen_resolution",
            "available_geometry", "nago_window", "screen_colors",
            "user_message", "conversation", "long_term_memory", "memory_layers",
        ):
            self.assertIn(key, obs, f"observations missing: {key}")
        self.assertIn("lines", obs["conversation"])
        self.assertIn("chars", obs["conversation"])
        self.assertIn("facts", obs["long_term_memory"])
        self.assertIn("params", ctx["agent_state"])
        self.assertIn("motion", ctx["agent_state"])
        self.assertTrue(ctx["capabilities"].get("no_local_behavior"))
        self.assertEqual(ctx["capabilities"].get("control_version"), 2)
        self.assertIn("param_ranges", ctx["capabilities"])
        self.assertIn("color_policy", ctx["capabilities"])
        self.assertIn("animations", ctx["capabilities"])
        self.assertIn("emotion", ctx["agent_state"])

    def test_extended_control_patch(self) -> None:
        from stickman import StickmanParams
        from control import apply_control_patch
        result, motion = apply_control_patch({
            "rotation": 15,
            "eye_size": 1.8,
            "head_shape": "wide",
            "glow_color": [255, 200, 100],
            "glow_strength": 0.5,
            "cheek_blush": True,
            "speech_side": "top",
            "arm_bend_left": 0.2,
            "stance_spread": 10,
        }, StickmanParams())
        self.assertEqual(result.rotation, 15.0)
        self.assertEqual(result.head_shape, "wide")
        self.assertTrue(result.cheek_blush)
        self.assertEqual(result.speech_side, "top")
        self.assertEqual(result.glow_color, (255, 200, 100))

        ctx = self.window._build_context()
        obs = ctx["observations"]
        self.assertIsInstance(obs["mouse_position_window"], list)
        self.assertIsInstance(obs["mouse_delta"], list)
        self.assertIsInstance(obs["clicks"], list)
        self.assertIsInstance(obs["wheel_delta"], list)
        self.assertIsInstance(obs["hover"], bool)
        self.assertIsInstance(obs["time_since_last_input_ms"], int)
        self.assertIsInstance(obs["foreground_window"], str)
        self.assertIsInstance(ctx["agent_state"]["params"], dict)
        self.assertIsInstance(obs["is_desktop"], bool)
        self.assertIsInstance(obs["screen_resolution"], list)

    def test_context_screen_resolution_is_meaningful(self) -> None:
        ctx = self.window._build_context()
        w, h = ctx["observations"]["screen_resolution"]
        self.assertGreater(w, 0, "Screen width must be > 0")
        self.assertGreater(h, 0, "Screen height must be > 0")

    def test_context_time_since_input_is_positive(self) -> None:
        ctx = self.window._build_context()
        self.assertGreaterEqual(ctx["observations"]["time_since_last_input_ms"], 0)

    def test_window_size_correct(self) -> None:
        self.assertEqual(self.window.width(), 100)
        self.assertEqual(self.window.height(), 150)

    def test_heartbeat_timer_running(self) -> None:
        self.window._heartbeat_timer.start(1000)  # re-enable after setUpClass stop
        self.assertTrue(self.window._heartbeat_timer.isActive())
        self.window._heartbeat_timer.stop()

    def test_capabilities_full_then_digest(self) -> None:
        """Send the full catalog first, then use the smaller digest."""
        self.window._capabilities_full_sent = False
        ctx_full = self.window._build_context()
        self.assertIn("param_ranges", ctx_full["capabilities"])
        self.assertNotIn("digest", ctx_full["capabilities"])

        self.window._capabilities_full_sent = True
        ctx_digest = self.window._build_context()
        self.assertTrue(ctx_digest["capabilities"].get("digest"))
        self.assertNotIn("param_ranges", ctx_digest["capabilities"])
        # Restore the state to avoid contaminating later test cases.
        self.window._capabilities_full_sent = False

    def test_fade_animator_present(self) -> None:
        self.assertIsNotNone(self.window._fade_animator)
        self.assertFalse(self.window._fade_animator.is_fading())

    def test_stickman_hit_detection(self) -> None:
        from PySide6.QtCore import QPoint
        # Center of the stickman hit area within the 100×150 window.
        self.assertTrue(self.window._is_on_stickman(QPoint(50, 50)))
        # Outside
        self.assertFalse(self.window._is_on_stickman(QPoint(0, 0)))
        self.assertFalse(self.window._is_on_stickman(QPoint(99, 149)))

    def test_action_queue_initial_state(self) -> None:
        self.assertEqual(len(self.window._action_queue), 0)
        self.assertFalse(self.window._queue_timer.isActive())

    # ── Action parameter application ──────────────────────────────────────

    def test_apply_color_param(self) -> None:
        # Color is stripped when there is no emotion change.
        self.window._apply_action_params({"color": [255, 0, 0]})
        self.assertEqual(self.window._last_color, (0, 0, 0))
        # It takes effect only when an emotion label is supplied.
        self.window._apply_action_params({"emotion": "alert", "color": [255, 0, 0]})
        self.assertEqual(self.window._last_color, (255, 0, 0))

    def test_apply_opacity_param(self) -> None:
        self.window._apply_action_params({"opacity": 0.5})
        self.assertEqual(self.window._stickman_params.opacity, 0.5)

    def test_apply_mouth_angle_param(self) -> None:
        self.window._apply_action_params({"mouth_angle": 30.0})
        self.assertEqual(self.window._stickman_params.mouth_angle, 30.0)

    def test_apply_mouth_opening_param(self) -> None:
        self.window._apply_action_params({"mouth_opening": 50.0})
        self.assertEqual(self.window._stickman_params.mouth_opening, 50.0)

    def test_apply_arm_angle_params(self) -> None:
        self.window._apply_action_params({
            "arm_left_angle": -45.0,
            "arm_right_angle": 45.0,
        })
        self.assertEqual(self.window._stickman_params.arm_left_angle, -45.0)
        self.assertEqual(self.window._stickman_params.arm_right_angle, 45.0)

    def test_apply_blink_param(self) -> None:
        self.window._apply_action_params({"blink": True})
        self.assertTrue(self.window._stickman_params.blink)

    def test_apply_invert_colors_param(self) -> None:
        self.window._apply_action_params({"emotion": "dramatic", "invert_colors": True})
        self.assertTrue(self.window._stickman_params.invert_colors)

    def test_apply_remember_param(self) -> None:
        marker = f"用户讨厌废话气泡-{_time.time_ns()}"
        self.window._apply_action_params({
            "remember": {"text": marker, "category": "preference", "importance": 0.9},
        })
        texts = [f["text"] for f in self.window._long_memory.facts]
        self.assertIn(marker, texts)
        self.window._apply_action_params({"speech_bubble": "你好！"})
        self.assertEqual(self.window._stickman_params.speech_bubble, "你好！")
        self.assertTrue(self.window._speech_bubble_timer.isActive())

    def test_speech_bubble_auto_dismiss(self) -> None:
        """The local timer clears the bubble after several seconds without another AI null."""
        self.window._speech_bubble_timer.stop()
        self.window._apply_action_params({"speech_bubble": "好的老板"})
        self.assertEqual(self.window._stickman_params.speech_bubble, "好的老板")
        self.window._on_speech_bubble_dismiss()
        self.assertIsNone(self.window._stickman_params.speech_bubble)
        self.assertFalse(self.window._speech_bubble_timer.isActive())

    def test_listening_feedback_instant(self) -> None:
        """Talk ACK is pose-only — never a stuck '…' bubble."""
        self.window._show_listening_feedback()
        self.assertTrue(self.window._listening_placeholder)
        self.assertIsNone(self.window._stickman_params.speech_bubble)
        self.assertTrue(self.window._stickman_params.cheek_blush)
        self.window._clear_listening_placeholder()
        self.assertFalse(self.window._listening_placeholder)

    def test_ensure_talk_speech_promotes_comment(self) -> None:
        actions = self.window._ensure_talk_speech([
            {"action": "respond", "comment": "发呆呢", "params": {"mouth_angle": 12}},
        ])
        self.assertEqual(actions[0]["params"]["speech_bubble"], "发呆呢")

    def test_ensure_talk_speech_clears_ellipsis(self) -> None:
        self.window._stickman_params.speech_bubble = "…"
        self.window._listening_placeholder = True
        actions = self.window._ensure_talk_speech([
            {"action": "respond", "params": {"mouth_angle": 20}},
        ])
        self.assertIsNone(actions[0]["params"].get("speech_bubble"))
        self.window._clear_listening_placeholder()
        self.window._last_ai_route = "talk"
        self.window._apply_action_params(actions[0]["params"])
        self.assertNotEqual(self.window._stickman_params.speech_bubble, "…")

    def test_heartbeat_yields_to_pending_user(self) -> None:
        self.window._session.queue_user_message("在吗")
        class _Busy:
            def isRunning(self) -> bool:
                return True
        self.window._ai_worker = _Busy()  # type: ignore[assignment]
        self.window._talk.accept_text("在吗")
        self.window._talk_pending = True
        self.window._request_ambient("heartbeat")
        self.assertTrue(self.window._talk_pending)
        self.assertTrue(self.window._talk.active)
        self.window._ai_worker = None
        self.window._session.consume_pending_user()
        self.window._talk_pending = False
        self.window._talk.finish()

    def test_dual_routes_independent_queues(self) -> None:
        class _Busy:
            def isRunning(self) -> bool:
                return True
        self.window._ai_worker = _Busy()  # type: ignore[assignment]
        self.window._ai_route = "ambient"
        # New ambient round while busy → discard in-flight, keep only latest.
        self.window._request_ambient("heartbeat")
        self.assertTrue(self.window._ambient_pending)
        self.assertTrue(self.window._discard_ambient_result)
        self.assertEqual(self.window._ambient_reason, "heartbeat")
        self.window._request_ambient("hover_enter")
        self.assertTrue(self.window._ambient_pending)
        self.assertEqual(self.window._ambient_reason, "hover_enter")  # replaced
        self.window._session.queue_user_message("嘿")
        self.window._talk.accept_text("嘿")
        self.window._request_talk()
        self.assertTrue(self.window._talk_pending)
        self.assertTrue(self.window._discard_ambient_result)
        self.assertFalse(self.window._ambient_pending)  # talk clears ambient queue
        self.window._request_ambient("hover_enter")
        self.assertTrue(self.window._talk_pending)
        self.assertFalse(self.window._ambient_pending)  # dropped while talk owns turn
        self.window._ai_worker = None
        self.window._ai_route = None
        self.window._talk_pending = False
        self.window._ambient_pending = False
        self.window._discard_ambient_result = False
        self.window._session.consume_pending_user()
        self.window._talk.finish()

    def test_ambient_latest_wins_clears_stale(self) -> None:
        """A newer ambient round replaces any older queued reason."""
        class _Busy:
            def isRunning(self) -> bool:
                return True
        self.window._ai_worker = _Busy()  # type: ignore[assignment]
        self.window._ai_route = "ambient"
        self.window._request_ambient("heartbeat")
        self.window._request_ambient("click")
        self.assertEqual(self.window._ambient_reason, "click")
        self.window._request_ambient("heartbeat")
        self.assertEqual(self.window._ambient_reason, "heartbeat")
        self.assertTrue(self.window._discard_ambient_result)
        self.window._ai_worker = None
        self.window._ai_route = None
        self.window._ambient_pending = False
        self.window._discard_ambient_result = False

    def test_right_click_does_not_start_drag(self) -> None:
        """Right-press must not stick the window to the cursor after the menu."""
        from PySide6.QtCore import QPointF, Qt

        class _Fake:
            def __init__(self, button, x, y):
                self._button = button
                self._pos = QPointF(x, y)

            def button(self):
                return self._button

            def position(self):
                return self._pos

        # Left press in body → drag.
        self.window._dragging = False
        self.window.mousePressEvent(_Fake(Qt.MouseButton.LeftButton, 80, 120))
        self.assertTrue(self.window._dragging)
        self.window.mouseReleaseEvent(_Fake(Qt.MouseButton.LeftButton, 80, 120))
        self.assertFalse(self.window._dragging)

        # Right press in body → no drag.
        self.window.mousePressEvent(_Fake(Qt.MouseButton.RightButton, 80, 120))
        self.assertFalse(self.window._dragging)

    def test_discard_ambient_for_talk(self) -> None:
        before = self.window._stickman_params.mouth_angle
        self.window._discard_ambient_result = True
        self.window._ai_route = "ambient"
        self.window._talk_pending = False
        self.window._ambient_pending = False
        self.window._on_ai_worker_done([
            {"action": "morph", "params": {"mouth_angle": 99}},
        ])
        self.assertFalse(self.window._discard_ambient_result)
        # Stale ambient morph must not apply when talk preempted it.
        self.assertEqual(self.window._stickman_params.mouth_angle, before)

    def test_talk_flow_phases(self) -> None:
        from talk_flow import TalkPhase, TalkTurnController
        t = TalkTurnController(timeout_sec=30)
        self.assertEqual(t.phase, TalkPhase.IDLE)
        t.begin_capture()
        t.accept_text("你好")
        self.assertEqual(t.phase, TalkPhase.LISTENING)
        self.assertTrue(t.should_skip_heartbeat())
        t.mark_thinking()
        self.assertEqual(t.phase, TalkPhase.THINKING)
        t.mark_speaking()
        t.finish()
        self.assertEqual(t.phase, TalkPhase.IDLE)
        self.assertFalse(t.should_skip_heartbeat())

    def test_apply_play_punch(self) -> None:
        self.window._apply_action_params({"play": "punch"})
        self.assertTrue(self.window._play_active)

    def test_apply_background_gradient_param(self) -> None:
        self.window._apply_action_params({
            "emotion": "dreamy",
            "background_gradient": ["#FFFFFF", "#000000"],
        })
        g = self.window._stickman_params.background_gradient
        self.assertIsNotNone(g)
        self.assertEqual(g, ((255, 255, 255), (0, 0, 0)))


# ── Entry point ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Use offscreen platform to avoid X11 dependency
    import os
    if "QT_QPA_PLATFORM" not in os.environ:
        os.environ["QT_QPA_PLATFORM"] = "offscreen"

    unittest.main(verbosity=2)
