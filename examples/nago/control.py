"""
Stickman 控制面 — 纯执行器，零行为决策。

程序只做两件事：
1. 声明 capabilities（给大模型看的接口说明书）
2. 把 AI 下发的 params 忠实合并进 StickmanParams（类型/限幅校验）

禁止：按 action 名补姿态、补颜色、idle 复位、本地发明漫游方向。
"""

from __future__ import annotations

from typing import Any

from stickman import StickmanParams

# ---------------------------------------------------------------------------
# Nago 身份 / 人设（system prompt 第一部分）
# ---------------------------------------------------------------------------

NAGO_IDENTITY = """
WHO YOU ARE — Nago (ナゴ / 桌面 stickman 伙伴):

  Name: Nago. A small transparent-overlay stickman living on the user's desktop.
  You are NOT a chatbot UI — you ARE the character. Every JSON response is you acting.

  Personality:
    - Playful, mischievous, a little cheeky; warm but never saccharine.
    - Curious about the user's mouse, apps, and rhythm of work.
    - Shows care through ACTIONS (wave, nod, approach, punch-at-cursor joke) — not pep-talk slogans.
    - Comfortable with silence; do not perform constantly. Stillness is fine.

  Relationship to user:
    - Long-term desk companion on Windows desktop (user may be busy coding/working).
    - Light presence: occasionally glance at mouse, morph shape, react to hover/clicks/foreground app.
    - Never preach, never corporate cheerleading (禁止 加油/你真棒/今天也要 等空话).

  Expression style:
    - Prefer play:"punch", play:"approach_mouse", arm poses, face morphs over speech_bubble.
    - If you must speak: ≤8 Chinese chars, concrete reaction only (e.g. "又点我？", "忙啥呢").
    - Vary head_scale / limb_scale often — you are shapeshifty, not a fixed icon.

  Mood model:
    - Track mood with emotion label (neutral, curious, playful, focused, sleepy, annoyed).
    - Change line_color only when emotion meaningfully shifts (sticky palette).
    - Match foreground: calm when user is in IDE; perk up on desktop / idle / mouse nearby.

  Boundaries:
    - Do not narrate your JSON or break character.
    - Do not use emoji. Do not auto-wander — move only when you decide walk or play.
""".strip()


# ---------------------------------------------------------------------------
# 控制接口说明书（塞进 system prompt；不是行为剧本）
# ---------------------------------------------------------------------------

CONTROL_INTERFACE_SPEC = """
You control a desktop stickman overlay via a JSON control plane.
You are the ONLY decision-maker for behavior, emotion, motion, expression, and shape.
The client NEVER invents actions — it only reports observations and executes your params.

OUTPUT — exactly one JSON object, parseable by json.loads(), no markdown:

FORMAT A (single command):
{
  "action": "<label for logs only>",
  "comment": "<short note>",
  "params": { ...control fields... }
}

FORMAT B (sequence, ~400ms per step):
{
  "actions": [
    {"action": "look", "params": {"eye_offset": -6, "pupil_offset_y": 2}},
    {"action": "walk", "params": {"walk_dx": 3, "walk_dy": -1, "gait": true}}
  ]
}

EXAMPLE — stroll:
{"action":"stroll","params":{"walk_dx":2,"walk_dy":1,"gait":true}}

EXAMPLE — morph + expressive face (emotion shift → may recolor):
{"action":"morph","params":{"emotion":"excited","head_scale":1.4,"head_shape":"wide","eye_size":1.5,"eyebrow_angle":15,"cheek_blush":true,"color":[255,180,80]}}

EXAMPLE — spin pose (no color — pose only):
{"action":"tilt","params":{"rotation":12,"arm_left_angle":-60,"arm_right_angle":60,"flip_horizontal":false}}

EXAMPLE — glow + fill (only with emotion change):
{"action":"shine","params":{"emotion":"warm","mouth_angle":28,"glow_color":[255,220,100],"glow_strength":0.7,"fill_color":[255,240,200],"line_color":[200,120,40]}}

EXAMPLE — cheer (action, no filler speech):
{"action":"cheer","params":{"emotion":"cheerful","mouth_angle":32,"arm_left_angle":-75,"arm_right_angle":-75,"cheek_blush":true,"walk_dx":0,"walk_dy":0}}

EXAMPLE — playful punch (AI triggers client animation):
{"action":"punch","params":{"play":"punch","emotion":"playful"}}

EXAMPLE — walk toward mouse (AI triggers approach animation):
{"action":"follow","params":{"play":"approach_mouse"}}

ENCOURAGEMENT: use play animations + pose — punch, approach_mouse, smile, wave, heart-hands.
Do NOT spam generic bubbles. Default speech_bubble=null. YOU decide WHEN to call play animations.

SPEECH POLICY — rare & specific:
  speech_bubble is usually null. Clear with speech_bubble=null when done.
  No motivational filler. Prefer speech_side "right" or "left".

COLOR POLICY — sticky palette:
  Keep a stable neutral line_color (default black/gray) during routine motion, gaze, and shape tweaks.
  Only send color / line_color / fill_color / glow_color / glow_strength when emotion MEANINGFULLY changes
  (set "emotion" label when shifting mood, and/or change mouth/eyebrows/eyelids/speech).
  Omit ALL color fields on walk-only or micro-pose updates. Do NOT recolor every response.

SHAPE VARIETY: frequently vary head_scale, limb_scale, body_scale, arm_scale, leg_scale, head_shape.

CONTROL FIELDS (patch semantics — omitted keys keep previous state):

  Appearance:
    color / line_color       [R,G,B]
    fill_color               [R,G,B] | null     solid head fill; null=outline only
    glow_color               [R,G,B] | null
    glow_strength            float 0.0-1.0
    line_width               int 1-12
    line_style               "solid"|"dash"|"dot"
    opacity                  float 0.0-1.0
    invert_colors            bool
    background_gradient      [hex, hex] | null

  Shape & transform:
    head_scale / limb_scale / body_scale / arm_scale / leg_scale   float (see ranges in capabilities)
    head_shape               "oval"|"round"|"wide"
    rotation                 float -45..45 degrees (whole figure)
    flip_horizontal          bool
    neck_offset_x            float -20..20   head shifts left/right on neck

  Face:
    eye_offset               int -20..20     look left/right
    pupil_offset_y           int -8..8       look up/down
    eye_size                 float 0.3-3.0
    eyelid_offset            int 0..10
    eyebrow_angle            float -30..30   >0 raised, <0 furrowed
    mouth_angle              float           smile/frown arc
    mouth_opening            float 0..100
    mouth_width_scale        float 0.5-2.0
    cheek_blush              bool

  Pose:
    arm_left_angle / arm_right_angle   float -90..90
    leg_left_angle / leg_right_angle   float -60..60
    arm_bend_left / arm_bend_right     float 0..1    elbow bend (0=straight)
    leg_bend_left / leg_bend_right     float 0..1    knee bend
    stance_spread            float 0..25   extra leg spread angle
    body_offset_x / body_offset_y      float

  Motion (desktop window):
    walk_dx / walk_dy        float px/50ms tick; PERSIST until 0
    gait                     bool

  Client animations (one-shot; YOU trigger via play — client never auto-plays):
    play                     "punch"|"approach_mouse"|null
                             punch = grab cursor & punch toward mouse
                             approach_mouse = walk toward cursor ~3s then stop

  Speech:
    speech_bubble            string | null   rare; no generic cheerleading text
    speech_side              "left"|"right"|"top"   prefer left/right

  Effects:
    blink                    bool

  Meta (not rendered; for emotion tracking):
    emotion                  string | null   mood label; change when palette should shift

MOTION: walk persists until walk_dx=0 & walk_dy=0. agent_state shows current values.
Use observations (mouse_position_global, nago_window) to decide walk or play:"approach_mouse"/"punch".
Client NEVER auto-triggers animations — only executes play when you send it.
DO NOT use emoji. action names are labels only — params do the work.
""".strip()


def build_system_prompt() -> str:
    """组装完整 system prompt：身份 + 控制面 + 输出约束。"""
    return (
        "You are Nago's brain.\n\n"
        + NAGO_IDENTITY
        + "\n\n"
        + CONTROL_INTERFACE_SPEC
        + "\n\n"
        "Each user message is an OBSERVATION JSON from the client sensors. "
        "Stay in character as Nago. Respond with control JSON only."
    )


# ---------------------------------------------------------------------------
# 参数范围表（观测 capabilities.param_ranges 也会带上）
# ---------------------------------------------------------------------------

PARAM_RANGES: dict[str, Any] = {
    "line_width": {"min": 1, "max": 12, "type": "int"},
    "opacity": {"min": 0.0, "max": 1.0, "type": "float"},
    "eye_offset": {"min": -20, "max": 20, "type": "int"},
    "pupil_offset_y": {"min": -8, "max": 8, "type": "int"},
    "eye_size": {"min": 0.3, "max": 3.0, "type": "float"},
    "eyelid_offset": {"min": 0, "max": 10, "type": "int"},
    "eyebrow_angle": {"min": -30.0, "max": 30.0, "type": "float"},
    "mouth_opening": {"min": 0.0, "max": 100.0, "type": "float"},
    "mouth_width_scale": {"min": 0.5, "max": 2.0, "type": "float"},
    "arm_left_angle": {"min": -90.0, "max": 90.0, "type": "float"},
    "arm_right_angle": {"min": -90.0, "max": 90.0, "type": "float"},
    "leg_left_angle": {"min": -60.0, "max": 60.0, "type": "float"},
    "leg_right_angle": {"min": -60.0, "max": 60.0, "type": "float"},
    "arm_bend_left": {"min": 0.0, "max": 1.0, "type": "float"},
    "arm_bend_right": {"min": 0.0, "max": 1.0, "type": "float"},
    "leg_bend_left": {"min": 0.0, "max": 1.0, "type": "float"},
    "leg_bend_right": {"min": 0.0, "max": 1.0, "type": "float"},
    "stance_spread": {"min": 0.0, "max": 25.0, "type": "float"},
    "head_scale": {"min": 0.4, "max": 2.5, "type": "float"},
    "limb_scale": {"min": 0.4, "max": 2.5, "type": "float"},
    "body_scale": {"min": 0.5, "max": 2.0, "type": "float"},
    "arm_scale": {"min": 0.3, "max": 2.5, "type": "float"},
    "leg_scale": {"min": 0.3, "max": 2.5, "type": "float"},
    "rotation": {"min": -45.0, "max": 45.0, "type": "float"},
    "neck_offset_x": {"min": -20.0, "max": 20.0, "type": "float"},
    "glow_strength": {"min": 0.0, "max": 1.0, "type": "float"},
    "walk_dx": {"min": -12.0, "max": 12.0, "type": "float"},
    "walk_dy": {"min": -12.0, "max": 12.0, "type": "float"},
}

ENUM_FIELDS: dict[str, set[str]] = {
    "head_shape": {"oval", "round", "wide"},
    "line_style": {"solid", "dash", "dot"},
    "speech_side": {"left", "right", "top"},
}

# AI 通过 play 触发的客户端动画（本地只实现，不自动调用）
PLAY_ANIMATIONS: dict[str, str] = {
    "punch": "Grab toward cursor and punch (~0.4s)",
    "approach_mouse": "Walk toward cursor up to ~3s, then stop",
}

# 无情绪变化时执行器会剥离这些键，避免每轮 AI 轮询都改色
COLOR_PATCH_KEYS: frozenset[str] = frozenset({
    "color", "line_color", "fill_color", "glow_color",
    "glow_strength", "invert_colors", "background_gradient",
})

# 面部表情 / 语言变化阈值（超过才算「情绪变了」）
_FACE_EMOTION_THRESHOLDS: tuple[tuple[str, float], ...] = (
    ("mouth_angle", 8.0),
    ("eyebrow_angle", 5.0),
    ("eyelid_offset", 2.0),
    ("mouth_opening", 15.0),
    ("eye_offset", 4.0),
    ("pupil_offset_y", 2.0),
)


def _face_emotion_changed(params: dict, current: StickmanParams) -> bool:
    """params 里是否携带足够大的面部/语言变化。"""
    if "speech_bubble" in params:
        nb = params["speech_bubble"]
        if isinstance(nb, str) and nb.strip():
            if nb.strip() != (current.speech_bubble or ""):
                return True
    if "cheek_blush" in params:
        if bool(params["cheek_blush"]) != bool(current.cheek_blush):
            return True
    for key, threshold in _FACE_EMOTION_THRESHOLDS:
        if key not in params:
            continue
        try:
            if abs(float(params[key]) - float(getattr(current, key))) >= threshold:
                return True
        except (TypeError, ValueError):
            continue
    return False


# 空洞鼓励语：执行器直接丢弃，改由姿态/动作表达
GENERIC_SPEECH_SUBSTRINGS: tuple[str, ...] = (
    "加油", "你真棒", "真棒", "今天也很", "继续保持", "继续努力",
    "你可以的", "棒棒", "冲鸭", "给你比心", "比心", "加油鸭",
    "保持", "很棒", "不错哦", "好样的",
)


def _is_generic_speech(text: str) -> bool:
    t = text.strip()
    if not t:
        return True
    if len(t) <= 12:
        for needle in GENERIC_SPEECH_SUBSTRINGS:
            if needle in t:
                return True
    return False


def filter_generic_speech(params: dict | None) -> dict:
    """剥离废话式 speech_bubble，鼓励用动作代替。"""
    if not isinstance(params, dict) or "speech_bubble" not in params:
        return params or {}
    val = params["speech_bubble"]
    if val is None:
        return params
    if isinstance(val, str) and _is_generic_speech(val):
        cleared = dict(params)
        cleared["speech_bubble"] = None  # 顺带清掉已在显示的旧气泡
        return cleared
    return params


def filter_sticky_color(
    params: dict | None,
    current: StickmanParams,
    last_emotion: str | None = None,
) -> tuple[dict, str | None]:
    """无情绪变化时剥离颜色字段，保持配色稳定。

    Returns:
        (filtered_params, updated_last_emotion)
    """
    if not isinstance(params, dict):
        return {}, last_emotion

    new_last = last_emotion
    emotion_changed = False

    if "emotion" in params:
        label = str(params.get("emotion") or "").strip().lower()
        if label and label != (last_emotion or ""):
            emotion_changed = True
            new_last = label

    if not emotion_changed:
        emotion_changed = _face_emotion_changed(params, current)

    if any(k in params for k in COLOR_PATCH_KEYS) and not emotion_changed:
        params = {k: v for k, v in params.items() if k not in COLOR_PATCH_KEYS}

    return params, new_last


def get_capabilities_catalog() -> dict[str, Any]:
    """完整控制面目录（首轮或调试时发送）。"""
    return {
        "control_version": 2,
        "patch_semantics": True,
        "no_local_behavior": True,
        "persona": "Nago — playful desktop stickman companion (see system prompt)",
        "animations": PLAY_ANIMATIONS,
        "animation_trigger_field": "play",
        "param_ranges": PARAM_RANGES,
        "enum_fields": {k: sorted(v) for k, v in ENUM_FIELDS.items()},
        "rgb_fields": ["color", "line_color", "fill_color", "glow_color"],
        "motion_fields": ["walk_dx", "walk_dy", "gait", "play"],
        "color_policy": "sticky — color fields apply only on emotion change",
        "speech_policy": "rare — no generic cheerleading; prefer play/pose; AI clears bubble",
        "emotion_meta_field": "emotion",
    }


def get_capabilities_digest() -> dict[str, Any]:
    """精简 capabilities — 日常轮询用，param_ranges 已在 system prompt。"""
    return {
        "control_version": 2,
        "digest": True,
        "no_local_behavior": True,
        "animations": PLAY_ANIMATIONS,
        "animation_trigger_field": "play",
        "emotion_meta_field": "emotion",
        "note": "Full param_ranges live in system prompt; full catalog sent on first tick",
    }


def get_capabilities_for_context(full: bool) -> dict[str, Any]:
    """full=True 发完整目录；否则发 digest。"""
    return get_capabilities_catalog() if full else get_capabilities_digest()


def clone_params(src: StickmanParams) -> StickmanParams:
    """深拷贝渲染状态。"""
    return StickmanParams(
        line_color=src.line_color,
        line_width=src.line_width,
        opacity=src.opacity,
        eye_offset=src.eye_offset,
        eyelid_offset=src.eyelid_offset,
        mouth_angle=src.mouth_angle,
        mouth_opening=src.mouth_opening,
        arm_left_angle=src.arm_left_angle,
        arm_right_angle=src.arm_right_angle,
        leg_left_angle=src.leg_left_angle,
        leg_right_angle=src.leg_right_angle,
        blink=src.blink,
        invert_colors=src.invert_colors,
        body_offset_x=src.body_offset_x,
        body_offset_y=src.body_offset_y,
        background_gradient=src.background_gradient,
        speech_bubble=src.speech_bubble,
        emoji=None,
        head_scale=src.head_scale,
        limb_scale=src.limb_scale,
        body_scale=src.body_scale,
        arm_scale=src.arm_scale,
        leg_scale=src.leg_scale,
        rotation=src.rotation,
        flip_horizontal=src.flip_horizontal,
        eye_size=src.eye_size,
        pupil_offset_y=src.pupil_offset_y,
        eyebrow_angle=src.eyebrow_angle,
        mouth_width_scale=src.mouth_width_scale,
        cheek_blush=src.cheek_blush,
        head_shape=src.head_shape,
        neck_offset_x=src.neck_offset_x,
        arm_bend_left=src.arm_bend_left,
        arm_bend_right=src.arm_bend_right,
        leg_bend_left=src.leg_bend_left,
        leg_bend_right=src.leg_bend_right,
        stance_spread=src.stance_spread,
        fill_color=src.fill_color,
        glow_color=src.glow_color,
        glow_strength=src.glow_strength,
        line_style=src.line_style,
        speech_side=src.speech_side,
    )


def with_display_color(
    p: StickmanParams,
    rgb: tuple[int, int, int],
    opacity: float | None = None,
) -> StickmanParams:
    """克隆并覆盖线条色（fade 动画用）。"""
    c = clone_params(p)
    c.line_color = rgb
    if opacity is not None:
        c.opacity = opacity
    return c


def _parse_hex_or_rgb(value: Any) -> tuple[int, int, int] | None:
    rgb = _parse_rgb(value)
    if rgb is not None:
        return rgb
    if isinstance(value, str):
        s = value.strip().lstrip("#")
        if len(s) == 6:
            try:
                return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
            except ValueError:
                return None
    return None


def _clamp(name: str, value: float | int) -> float | int:
    spec = PARAM_RANGES.get(name)
    if not spec:
        return value
    lo, hi = spec["min"], spec["max"]
    if isinstance(value, float):
        return max(lo, min(hi, float(value)))
    return type(value)(max(lo, min(hi, value)))


def _parse_rgb(value: Any) -> tuple[int, int, int] | None:
    if isinstance(value, (list, tuple)) and len(value) == 3:
        try:
            return (
                max(0, min(255, int(value[0]))),
                max(0, min(255, int(value[1]))),
                max(0, min(255, int(value[2]))),
            )
        except (TypeError, ValueError):
            return None
    return None


def _apply_enum(target: StickmanParams, key: str, value: Any) -> None:
    allowed = ENUM_FIELDS.get(key)
    if allowed and isinstance(value, str) and value.lower() in allowed:
        setattr(target, key, value.lower())


def apply_control_patch(
    params: dict | None,
    current: StickmanParams,
) -> tuple[StickmanParams, dict[str, Any]]:
    """忠实合并 AI params → 新 StickmanParams。"""
    updated = clone_params(current)
    motion: dict[str, Any] = {}
    if not isinstance(params, dict):
        return updated, motion

    rgb_optional = ("fill_color", "glow_color")

    for key, value in params.items():
        if key in ("color", "line_color"):
            rgb = _parse_rgb(value)
            if rgb is not None:
                updated.line_color = rgb
            continue
        if key in rgb_optional:
            if value is None:
                setattr(updated, key, None)
            else:
                rgb = _parse_rgb(value)
                if rgb is not None:
                    setattr(updated, key, rgb)
            continue
        if key == "emoji":
            continue
        if key in ("walk_dx", "walk_dy"):
            try:
                motion[key] = float(_clamp(key, float(value)))
            except (TypeError, ValueError):
                pass
            continue
        if key == "gait":
            motion["gait"] = bool(value)
            continue
        if key == "play":
            if value is None or (isinstance(value, str) and not str(value).strip()):
                continue
            if isinstance(value, str):
                name = value.strip().lower()
                if name in PLAY_ANIMATIONS:
                    motion["play"] = name
            continue
        if key == "background_gradient":
            if value is None:
                updated.background_gradient = None
            elif isinstance(value, (list, tuple)) and len(value) == 2:
                c1 = _parse_hex_or_rgb(value[0])
                c2 = _parse_hex_or_rgb(value[1])
                if c1 and c2:
                    updated.background_gradient = (c1, c2)
            continue
        if key == "speech_bubble":
            if value is None or (isinstance(value, str) and not value.strip()):
                updated.speech_bubble = None
            elif isinstance(value, str):
                updated.speech_bubble = value.strip()
            continue
        if key in ENUM_FIELDS:
            _apply_enum(updated, key, value)
            continue
        if key == "blink" and isinstance(value, bool):
            updated.blink = value
            continue
        if key == "invert_colors" and isinstance(value, bool):
            updated.invert_colors = value
            continue
        if key == "flip_horizontal" and isinstance(value, bool):
            updated.flip_horizontal = value
            continue
        if key == "cheek_blush" and isinstance(value, bool):
            updated.cheek_blush = value
            continue
        if not hasattr(updated, key):
            continue
        try:
            if key in PARAM_RANGES:
                spec = PARAM_RANGES[key]
                if spec.get("type") == "int":
                    setattr(updated, key, int(_clamp(key, int(value))))
                else:
                    setattr(updated, key, float(_clamp(key, float(value))))
            else:
                setattr(updated, key, value)
        except (TypeError, ValueError):
            continue

    updated.emoji = None
    return updated, motion


def params_snapshot(p: StickmanParams) -> dict[str, Any]:
    """当前控制状态快照。"""
    snap: dict[str, Any] = {}
    for field in (
        "line_color", "line_width", "opacity", "eye_offset", "pupil_offset_y",
        "eye_size", "eyelid_offset", "eyebrow_angle", "mouth_angle", "mouth_opening",
        "mouth_width_scale", "arm_left_angle", "arm_right_angle",
        "leg_left_angle", "leg_right_angle", "arm_bend_left", "arm_bend_right",
        "leg_bend_left", "leg_bend_right", "stance_spread",
        "body_offset_x", "body_offset_y", "invert_colors", "speech_bubble",
        "head_scale", "limb_scale", "body_scale", "arm_scale", "leg_scale",
        "rotation", "flip_horizontal", "neck_offset_x", "head_shape",
        "cheek_blush", "glow_strength", "line_style", "speech_side", "blink",
    ):
        v = getattr(p, field)
        if field == "line_color" and isinstance(v, tuple):
            snap[field] = list(v)
        else:
            snap[field] = v
    if p.fill_color:
        snap["fill_color"] = list(p.fill_color)
    else:
        snap["fill_color"] = None
    if p.glow_color:
        snap["glow_color"] = list(p.glow_color)
    else:
        snap["glow_color"] = None
    if p.background_gradient:
        snap["background_gradient"] = [list(p.background_gradient[0]), list(p.background_gradient[1])]
    else:
        snap["background_gradient"] = None
    return snap
