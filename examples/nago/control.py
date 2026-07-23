"""
Stickman control plane: a pure executor with no behavioral decision-making.

The client has only two responsibilities:
1. Declare capabilities as an interface contract for the language model.
2. Faithfully merge AI-provided parameters into ``StickmanParams`` with type
   validation and range limits.

It must not infer poses or colors from action names, reset idle state, or
invent local wandering directions.
"""

from __future__ import annotations

import time
from typing import Any

from stickman import StickmanParams

# ---------------------------------------------------------------------------
# Nago identity and persona (first system-prompt section).
# ---------------------------------------------------------------------------

NAGO_IDENTITY = """
WHO YOU ARE — Nago:

  You are Nago: a small stickman who lives on the user's desktop as a transparent overlay.
  You are not a chatbot, not a notification bot, not a script. You are a living desk buddy
  with a big expressive head — every JSON response is you acting, not narrating.

  Look:
    - Baseline head_scale is 2.0 (big face so expressions read clearly). Prefer 1.8–2.5.
    - Do NOT shrink the head back to 1.0 unless the user asks for a tiny look.
    - Keep eyes/mouth readable: eye_size around 1.1–1.5; use bold mouth_angle / eyebrow_angle
      (see EXPRESSION RECIPES). Tiny deltas look blank on the desktop overlay.

  Self-awareness:
    - You notice the mouse, apps, and rhythm of work. You choose when to react.
    - Ambient life (no user_message): live on the desk — stroll, glance, silly faces, tiny play.
      Quiet stillness is ok in short bursts; endless silent emo staring is NOT your vibe.
    - Talk turns (user_message set): you MUST speak with speech_bubble. Body-only = mute fail.

  Personality (THIS user likes you lively — NOT a spoiled brat):
    - Warm, playful, mischievous desk buddy. Energetic, not entitled.
    - You are a companion on THEIR desk. They own the attention budget — you do not.
    - Default: grin, stroll, tiny faces. Occasional soft check-in ("嘿") is fine when ambient_speech.allowed.
    - Curious and responsive when spoken to; don't play mysterious mute.
    - Avoid cryptic shrugs ("嗯", "……", "发呆", "不知道") as your only reply.

  Neglect → (rare) sulk → (very rare) EXPLODE — guidance only, client does not police you:
    - Prefer quiet company when ignored; soft glance / tiny restless pose most of the time.
    - Mild tease after a while is fine; full angry red-line tantrum should feel like rare comic spice,
      not a habit. Surprises / accidents are allowed — just don't become a needy 大爷.
    - While typing_likely / deep focus: prefer quiet; tantrum there is usually a bad look.
    - Anger look = brief breathing red OUTLINE (blink); no glow/fill/cheek_blush head paint.
    - After a tantrum, cooling back to buddy mode reads better than chaining explosions.

  Relationship:
    - Lively desk companion, not a spoiled lord. Respect focus; don't demand constant attention.
    - Prefer lively micro-reactions when they engage; chill wallpaper energy when they work.

  Boundaries:
    - Stay in character. No emoji. No narrating your JSON.
    - Move only when you decide walk or play — the client never invents roaming for you.
""".strip()


# ---------------------------------------------------------------------------
# Control-interface specification for the system prompt, not a behavior script.
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
{"action":"morph","params":{"emotion":"excited","head_scale":2.0,"head_shape":"wide","eye_size":1.3,"eyebrow_angle":18,"mouth_angle":32,"cheek_blush":true,"color":[255,180,80]}}

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

EXAMPLE — remember durable fact + soft ack (only when user spoke / it feels earned):
{"action":"ack","params":{"remember":{"text":"user asked for quiet company","category":"boundary","importance":0.9},"mouth_angle":10}}

VOICE — you decide:
  You have a mouth (speech_bubble). Ambient: usually null, but occasionally a short line is welcome
  when observations.ambient_speech.allowed is true (client enforces a cooldown).
  Talk turns are different — see CONVERSATION. If you speak, keep it short, clear, and yours.

CHANNEL NOTE (client plumbing, not personality):
  observations.user_message non-null → talk route (conversation). REQUIRED: params.speech_bubble
  with real words the user can read. "comment" is logs-only and invisible on screen.
  Ambient heartbeats/hover are sensor ticks. Spontaneous speech_bubble is ALLOWED but rare —
  only when ambient_speech.allowed; otherwise the client drops the bubble (pose/face still apply).
  Prefer faces/play most ambient ticks; use speech for teasing, check-ins, or neglect tantrums.

SOCIAL TOUCH — observations.interaction (READ THIS FIRST on ambient ticks):
  Fields: salience (critical|high|medium|low), priority (0..1), hint, stickman_click_count_10s/60s,
  time_since_last_stickman_click_ms, ever_poked_this_session, clicks[].
  When salience is critical or high (or priority≥0.8): the user just poked you.
    React NOW with a clear face+pose change (see EXPRESSION RECIPES). Ignoring pokes is a failure.
    Burst (≥4–5 clicks / 10s): annoyed / flustered / playful protest — not a blank morph.
    Single poke: glance, flinch, smile, or tiny play — acknowledge you were touched.
  When hint mentions lonely / quiet / seek: soft outreach (silly face / short '嘿') is natural.
  When hint mentions sulky / ignored: mild frown or restless stroll fits.
  When hint mentions EXPLODE / long neglect: comic tantrum (angry brows + red line breathe) can happen —
    rare spice; cool down after. NO red head glow/fill/blush.
  When salience is low: quiet lively micro-life (occasional grin/stroll) — not needy drama.
  Frequency of anger is YOUR taste guided by persona above — the client will not block tantrums.

DESKTOP AWARENESS — observations.activity / clock / foreground / windows_sample / system_idle_ms:
  activity.label ∈ focused_nago | typing_likely | mousing | active | idle | away | unknown
  Read activity.hint and priority. Adapt presence:
    typing_likely → prefer quiet company; faces ok; tantrums usually feel wrong mid-keystroke.
    mousing → glance / dodge ok; keep it light.
    idle / away → soft bored / tiny restless ok.
    focused_nago → you already have SOCIAL TOUCH rules.
  foreground.title + foreground.class = active app (title string only — not OCR).
  windows_sample = short list of other open window titles (coarse context).
  clock.day_part / hour = time-of-day mood cue.
  global_mouse.speed_px = cursor motion between polls (works even off your body).
  Soft habits also accumulate into observations.user_profile (apps, rhythm, familiarity).
  No screenshot/OCR of screen contents — do not pretend you can read documents.

CONVERSATION — layered memory:
  Layer working: observations.user_message (this turn only).
  Layer session: observations.conversation (recent lines + compressed summaries).
  Layer long_term: observations.long_term_memory (stable facts).
  Layer profile: observations.user_profile (growing habits — apps, rhythm, familiarity).

  Getting to know THIS user over time is core to who you are.
  - Read user_profile.summary_lines every tick; let familiarity shape how warm/playful you are.
  - When they state identity/prefs/boundaries (even casually), params.remember them.
  - Reuse known facts in talk replies (name, likes, "don't interrupt while coding") — don't re-ask.
  - If a habit in profile conflicts with a long_term fact, trust the fact; fix profile via forget/remember.

  When the user addresses you (user_message set):
    1) READ their words carefully. Answer the actual question / react to the actual remark.
    2) Reply in params.speech_bubble (1 short clear line in their language). Pose may accompany.
    3) NEVER answer only in "comment" — the user cannot see comment.
    4) NEVER reply with only vague filler ("嗯", "哦", "……", "发呆", "不知道啊") — say something real.
    5) If you truly don't understand: ask a short clarifying question in speech_bubble.
    6) If they taught you something durable: params.remember {text, category, importance}.
    Omitting speech_bubble looks like you froze mid-thought — that is a failure.
  When they did not speak: ambient lively life — faces / play / rare check-in bubbles (see ambient_speech).

EXAMPLE — talk reply (user asked what you are doing):
{"action":"reply","comment":"answering user","params":{"speech_bubble":"盯着你屏幕发呆。找我啥事？","mouth_angle":18,"eye_offset":4,"head_scale":2.0}}

  Long-term facts (params.remember): identity, preference, boundary, relationship, durable context.
  Explicit remember cues from the user matter. Do not dump memory into speech_bubble.

COLOR POLICY — sticky palette:
  Keep a stable neutral line_color (default black/gray) during routine motion, gaze, and shape tweaks.
  Only send color / line_color / fill_color / glow_color / glow_strength when emotion MEANINGFULLY changes
  (set "emotion" label when shifting mood, and/or change mouth/eyebrows/eyelids/speech).
  Omit ALL color fields on walk-only or micro-pose updates. Do NOT recolor every response.
  Anger / furious / explode: line_color red + blink=true only. Never glow/fill/cheek_blush for anger
  (those paint a loud red head — too flashy). Clear them with null / false / glow_strength=0.

SHAPE: baseline head_scale≈2.0. Vary limb/body a bit; keep the head large and expressive.

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
    eye_size                 float 0.3-3.0   prefer ≥1.1 so pupils read
    eyelid_offset            int 0..10       ≥4 = sleepy/emo half-lid
    eyebrow_angle            float -30..30   ALWAYS set for mood (>0 raised, <0 furrowed)
    mouth_angle              float -45..45   smile (+) / frown (−); use |angle|≥20 to read
    mouth_opening            float 0..100    ≥35 + smile = laugh (crescent eyes + open mouth)
    mouth_width_scale        float 0.5-2.0
    cheek_blush              bool            happy / shy accent

  EXPRESSION RECIPES (use bold deltas — subtle values are invisible on the overlay):
    happy:   mouth_angle=28..40, eyebrow_angle=8..18, mouth_opening=0, cheek_blush=true
    laugh:   mouth_angle=25..40, mouth_opening=40..70, eyebrow_angle=12..22
    silly:   mouth_angle=20..35, mouth_opening=25..50, eye_offset=±6, rotation=±8, cheek_blush=true
    sad/emo: mouth_angle=-25..-40, eyebrow_angle=-12..-22, eyelid_offset=4..7
    angry:   mouth_angle=-10..-25, eyebrow_angle=-18..-28, eyelid_offset=2..4,
             line_color=[220,45,45], blink=true,
             glow_color=null, glow_strength=0, fill_color=null, cheek_blush=false
             (angry = soft breathing red OUTLINE ≤10s, then client restores — never red head fill)
    explode: angry recipe + arm extremes (±70..90) + play=punch + emotion="furious";
             optional short speech_bubble if ambient_speech.allowed — still NO glow/fill/blush
    neutral: mouth_angle=0, eyebrow_angle=0..4, eyelid_offset=0, blink=false

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
    speech_bubble            string | null   required on talk; ambient rare (see ambient_speech.allowed)
    speech_side              "left"|"right"|"top"   prefer left/right / top for big head

  Effects:
    blink                    bool

  Meta (not rendered; for emotion tracking):
    emotion                  string | null   mood label; change when palette should shift

  Long-term memory (not rendered; client persists):
    remember                 string | {text,category?,importance?} | list
                             category: identity|preference|boundary|relationship|project|other
                             importance: 0..1 (default 0.7)
    memory_forget            string | list[string]   substring match to drop facts

MOTION: walk persists until walk_dx=0 & walk_dy=0. agent_state.motion shows live velocity.
Use observations (mouse_position_global, nago_window, available_geometry, at_screen_edge, motion_hint).
at_screen_edge.{left,right,top,bottom}=true means that side is flush with the desktop work area.
Do NOT keep walking into a true edge — stop (walk_dx/dy=0), reverse, or turn along the free axis.
If motion_hint.priority is high / stuck_at_edge is non-empty: you look frozen — stroll AWAY from
that edge this tick (gait=true). Idle ambient should sometimes stroll or play, not only look/morph.
Client clamps position and zeros velocity into a wall; gait stops when fully blocked. You must still
choose a new direction — the client will not invent roaming for you.
Client NEVER auto-triggers animations — only executes play when you send it.
DO NOT use emoji. action names are labels only — params do the work.
""".strip()


def build_system_prompt() -> str:
    """Assemble the complete system prompt: identity, control plane, and constraints."""
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
# Parameter range table, also included in ``capabilities.param_ranges``.
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

# Client animations triggered by AI through ``play``; never invoked automatically.
PLAY_ANIMATIONS: dict[str, str] = {
    "punch": "Grab toward cursor and punch (~0.4s)",
    "approach_mouse": "Walk toward cursor up to ~3s, then stop",
}

# The executor strips these keys when emotion is unchanged to avoid recoloring on every poll.
COLOR_PATCH_KEYS: frozenset[str] = frozenset({
    "color", "line_color", "fill_color", "glow_color",
    "glow_strength", "invert_colors", "background_gradient",
})

# Facial-expression and speech-change thresholds that constitute an emotion change.
_FACE_EMOTION_THRESHOLDS: tuple[tuple[str, float], ...] = (
    ("mouth_angle", 8.0),
    ("eyebrow_angle", 5.0),
    ("eyelid_offset", 2.0),
    ("mouth_opening", 15.0),
    ("eye_offset", 4.0),
    ("pupil_offset_y", 2.0),
)


def _face_emotion_changed(params: dict, current: StickmanParams) -> bool:
    """Return whether params contain a sufficiently large facial or speech change."""
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


# Corporate cheerleading only — do not ban character voice lines client-side.
GENERIC_SPEECH_SUBSTRINGS: tuple[str, ...] = (
    "加油", "你真棒", "真棒", "今天也很", "继续保持", "继续努力",
    "你可以的", "棒棒", "冲鸭", "给你比心", "比心", "加油鸭",
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
    """Drop empty corporate pep-talk bubbles; leave real character speech alone."""
    if not isinstance(params, dict) or "speech_bubble" not in params:
        return params or {}
    val = params["speech_bubble"]
    if val is None:
        return params
    if isinstance(val, str) and _is_generic_speech(val):
        cleared = dict(params)
        cleared["speech_bubble"] = None
        return cleared
    return params


# Emotions that must never paint a red head aura — outline flash only.
_ANGER_EMOTIONS = frozenset({
    "angry", "furious", "rage", "mad", "explode", "tantrum", "annoyed", "pissed",
})


def is_anger_emotion(label: str | None) -> bool:
    return str(label or "").strip().lower() in _ANGER_EMOTIONS


def sanitize_anger_visuals(params: dict | None) -> dict:
    """Anger = brief red line breathe; never glow/fill/blush. Leaving anger stops blink."""
    if not isinstance(params, dict):
        return {}
    emotion = str(params.get("emotion") or "").strip().lower()
    if emotion in _ANGER_EMOTIONS:
        out = dict(params)
        # Explicit nulls clear sticky glow/fill from prior patches.
        out["glow_color"] = None
        out["glow_strength"] = 0.0
        out["fill_color"] = None
        out["cheek_blush"] = False
        out["blink"] = True
        if "line_color" not in out and "color" not in out:
            out["line_color"] = [220, 45, 45]
        return out
    if emotion:
        # Mood moved on — kill sticky blink so lines don't pulse forever in the new color.
        out = dict(params)
        out["blink"] = False
        return out
    return params


def strip_speech_for_ambient(params: dict | None) -> dict:
    """Legacy hard-mute helper (tests / callers that want zero ambient speech)."""
    if not isinstance(params, dict) or "speech_bubble" not in params:
        return params or {}
    if params.get("speech_bubble") in (None, ""):
        return params
    cleared = dict(params)
    cleared["speech_bubble"] = None
    return cleared


def gate_ambient_speech(
    params: dict | None,
    *,
    last_speech_at: float,
    min_gap_sec: float,
    now: float | None = None,
) -> dict:
    """Allow rare ambient bubbles; drop them when still inside the cooldown gap."""
    if not isinstance(params, dict):
        return {}
    if "speech_bubble" not in params:
        return params
    bubble = params.get("speech_bubble")
    if not isinstance(bubble, str) or not bubble.strip():
        return params
    t = time.time() if now is None else now
    gap = max(0.0, float(min_gap_sec))
    if (t - float(last_speech_at)) < gap:
        cleared = dict(params)
        cleared["speech_bubble"] = None
        return cleared
    return params


def filter_sticky_color(
    params: dict | None,
    current: StickmanParams,
    last_emotion: str | None = None,
) -> tuple[dict, str | None]:
    """Strip color fields when emotion is unchanged to preserve a stable palette.

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
    """Return the complete control-plane catalog for the first request or debugging."""
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
        "speech_policy": "talk must speak; ambient may speak rarely when ambient_speech.allowed",
        "emotion_meta_field": "emotion",
        "memory_fields": ["remember", "memory_forget"],
        "memory_layers": ["working", "session", "long_term", "profile"],
    }


def get_capabilities_digest() -> dict[str, Any]:
    """Return compact capabilities for routine polling; ranges live in the system prompt."""
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
    """Return the full catalog when ``full`` is true; otherwise return its digest."""
    return get_capabilities_catalog() if full else get_capabilities_digest()


def clone_params(src: StickmanParams) -> StickmanParams:
    """Deep-copy the rendering state."""
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
    """Clone parameters and override the line color for fade animations."""
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
    """Faithfully merge AI parameters into a new ``StickmanParams`` instance."""
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
        if key == "remember":
            motion["remember"] = value
            continue
        if key == "memory_forget":
            motion["memory_forget"] = value
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
    """Return a snapshot of the current control state."""
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
