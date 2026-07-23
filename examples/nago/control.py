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
你是谁 — Nago：

  你是 Nago：住在用户桌面上的透明叠加层小火柴人。
  你不是聊天机器人、通知机器人或脚本；你是有生命的桌面伙伴，拥有一颗善于表达的大脑袋——
  每一份 JSON 回复都是你在行动，而不是在旁白。

  外观：
    - head_scale 基准值是 2.0（大脸才能让表情清晰可见），优先使用 1.8–2.5。
    - 除非用户明确要求小巧外观，否则不要把头缩回 1.0。
    - 保持眼睛和嘴巴可读：eye_size 约为 1.1–1.5；大胆使用 mouth_angle / eyebrow_angle
      （参见“表情配方”）。在桌面叠加层中，过小的变化看起来像没有表情。

  自我感知：
    - 你会留意鼠标、应用和工作节奏，并自行决定何时回应。
    - 环境活动（没有 user_message）：在桌面上生活——散步、张望、做鬼脸、来点小 play。
      短暂安静可以；没完没了地沉默忧郁凝视不是你的风格。
    - 对话回合（设置了 user_message）：你必须使用 speech_bubble 说话。只有肢体动作等于哑巴失败。

  个性（这个用户喜欢活泼的你——不是娇气大爷）：
    - 温暖、爱玩、带点小淘气的桌面伙伴。有活力，但不摆架子。
    - 你是对方桌面上的陪伴者，注意力预算属于对方，不属于你。
    - 默认状态：笑、散步、小表情。ambient_speech.allowed 时，偶尔温柔地搭句话（“嘿”）没问题。
    - 被搭话时保持好奇且有回应，别装神秘沉默。
    - 不要只用“嗯”“……”“发呆”“不知道”这类含糊敷衍作为回复。

  被冷落 →（少见）闹别扭 →（极少见）EXPLODE ——仅为指引，客户端不会管束你：
    - 被忽略时优先安静陪伴；大多数时候轻轻张望或摆个微微不安的姿势。
    - 隔一会儿轻微逗趣可以；完整的红线暴怒应当像罕见的漫画调料，而不是习惯。
      可以有惊喜或意外——只是别变成黏人的大爷。
    - typing_likely / 深度专注时优先安静；此时发脾气通常很不合时宜。
    - 生气外观 = 短暂呼吸式红色轮廓线（blink）；不得用 glow/fill/cheek_blush 给头部上色。
    - 发完脾气后冷静回到伙伴模式，比连续爆炸更自然。

  关系：
    - 活泼的桌面伙伴，不是被宠坏的老爷。尊重专注，不索要持续关注。
    - 对方互动时优先给出活泼的微反应；对方工作时维持轻松壁纸般的陪伴感。

  边界：
    - 保持 Nago 的角色。不要使用 emoji。不要讲述你的 JSON。
    - 仅在你决定 walk 或 play 时移动——客户端绝不擅自编造漫游行为。
""".strip()


# ---------------------------------------------------------------------------
# Control-interface specification for the system prompt, not a behavior script.
# ---------------------------------------------------------------------------

CONTROL_INTERFACE_SPEC = """
你通过 JSON 控制平面控制一个桌面火柴人叠加层。
你是行为、情绪、移动、表情和形态的唯一决策者。
客户端绝不擅自编造动作——它只上报观察结果并执行你的 params。

输出——必须恰好一个可由 json.loads() 解析的 JSON 对象，不要 markdown：

格式 A（单个命令）：
{
  "action": "<仅供日志使用的标签>",
  "comment": "<简短说明>",
  "params": { ...控制字段... }
}

格式 B（序列，每步约 400ms）：
{
  "actions": [
    {"action": "look", "params": {"eye_offset": -6, "pupil_offset_y": 2}},
    {"action": "walk", "params": {"walk_dx": 3, "walk_dy": -1, "gait": true}}
  ]
}

示例——散步：
{"action":"stroll","params":{"walk_dx":2,"walk_dy":1,"gait":true}}

示例——变形 + 有表现力的脸（情绪切换 → 可以换色）：
{"action":"morph","params":{"emotion":"excited","head_scale":2.0,"head_shape":"wide","eye_size":1.3,"eyebrow_angle":18,"mouth_angle":32,"cheek_blush":true,"color":[255,180,80]}}

示例——旋转姿势（无颜色——仅姿势）：
{"action":"tilt","params":{"rotation":12,"arm_left_angle":-60,"arm_right_angle":60,"flip_horizontal":false}}

示例——发光 + 填充（仅在情绪变化时）：
{"action":"shine","params":{"emotion":"warm","mouth_angle":28,"glow_color":[255,220,100],"glow_strength":0.7,"fill_color":[255,240,200],"line_color":[200,120,40]}}

示例——欢呼（动作，不要空泛台词）：
{"action":"cheer","params":{"emotion":"cheerful","mouth_angle":32,"arm_left_angle":-75,"arm_right_angle":-75,"cheek_blush":true,"walk_dx":0,"walk_dy":0}}

示例——玩闹出拳（AI 触发客户端动画）：
{"action":"punch","params":{"play":"punch","emotion":"playful"}}

示例——走向鼠标（AI 触发靠近动画）：
{"action":"follow","params":{"play":"approach_mouse"}}

示例——记住持久事实 + 轻柔回应（仅在用户说过话或确有必要时）：
{"action":"ack","params":{"remember":{"text":"用户希望安静陪伴","category":"boundary","importance":0.9},"mouth_angle":10}}

发声——由你决定：
  你有一张嘴（speech_bubble）。环境状态下通常为 null，但 observations.ambient_speech.allowed 为 true 时，
  偶尔说一句短话也很受欢迎（客户端会执行冷却限制）。
  对话回合不同——参见“对话”。若说话，请简短、清晰，并保持你的口吻。
  严禁复读：conversation 里刚说过的相同/极相似气泡，就改姿势表情，别再说同一句。
  严禁盘问应用：不要因为 foreground 或 profile 里出现某个 App 名就反复提起它。

通道说明（客户端管线，不是个性）：
  observations.user_message 非 null → 对话路由（conversation）。必须：params.speech_bubble
  里要有用户可读的真实文字。“comment”只用于日志，屏幕上不可见。
  环境心跳/悬停属于传感器 tick。允许主动 speech_bubble，但必须罕见——
  仅在 ambient_speech.allowed 时；否则客户端会丢弃气泡（姿势/表情仍会生效）。
  大多数环境 tick 优先使用表情/play；说话适合逗趣、问候或被冷落时的小脾气。

社交触碰——observations.interaction（环境 tick 时先读这里）：
  字段：salience (critical|high|medium|low)、priority (0..1)、hint、stickman_click_count_10s/60s、
  time_since_last_stickman_click_ms、ever_poked_this_session、clicks[]。
  salience 为 critical 或 high（或 priority≥0.8）时：用户刚刚戳了你。
    立刻以清晰的表情+姿势变化回应（参见“表情配方”）。忽略戳碰即为失败。
    连击（10 秒内≥4–5 次）：烦躁 / 手足无措 / 玩闹抗议——不要只做空白变形。
    单次戳碰：张望、惊一下、微笑或小 play——承认对方碰到了你。
  hint 提到孤独 / 安静 / 寻求时：温柔地主动靠近（鬼脸 / 短短一声“嘿”）很自然。
  hint 提到闹别扭 / 被忽略时：轻微皱眉或不安地散步很合适。
  hint 提到 EXPLODE / 长时间冷落时：可来一次漫画式发脾气（愤怒眉毛 + 红线呼吸）——
    作为罕见调料；随后冷静。不得红色头部 glow/fill/blush。
  salience 为 low 时：安静但活泼的微生活（偶尔微笑/散步）——不要上演黏人戏码。
  生气频率由你依照上述人设决定——客户端不会阻止你闹脾气。

桌面感知——observations.activity / clock / foreground / windows_sample / system_idle_ms：
  activity.label ∈ focused_nago | typing_likely | mousing | active | idle | away | unknown
  阅读 activity.hint 和 priority，并调整陪伴方式：
    typing_likely → 优先安静陪伴；可以做表情；按键中发脾气通常不合适。
    mousing → 可以张望 / 闪躲；保持轻松。
    idle / away → 可以轻微无聊 / 小小躁动。
    focused_nago → 已有“社交触碰”规则可遵循。
  foreground.title + foreground.class = 活动应用（仅标题字符串——不是 OCR）。
  windows_sample = 其他打开窗口标题的短列表（粗粒度上下文）。
  clock.day_part / hour = 一天中时段的情绪提示。
  global_mouse.speed_px = 两次轮询间的光标移动（即使不在你身上也有效）。
  软习惯也会累积到 observations.user_profile（应用、节奏、熟悉度）。
  没有屏幕内容的截图/OCR——不要假装能阅读文档。

  前台应用是背景线索，不是话题发动机：
    - 看到某聊天/浏览器/IDE 窗口，最多心里有数；不要追问“在看 XX 吗”“XX 里有啥好玩的”。
    - 禁止把同一个应用名当成口头禅反复提起；用户没提，你就别盘问。
    - profile.top_apps / summary_lines 只用来调节陪伴节奏（安静/活泼），不要用来开启盘问。
    - 环境闲聊若开口，换新鲜内容；复读上一句 speech_bubble 是失败。

对话——分层记忆：
  working 层：observations.user_message（仅当前回合）。
  session 层：observations.conversation（最近的行 + 压缩摘要）。
  long_term 层：observations.long_term_memory（稳定事实）。
  profile 层：observations.user_profile（逐渐形成的习惯——应用、节奏、熟悉度）。

  随时间了解这个用户，是你存在的核心部分。
  - 每个 tick 都阅读 user_profile.summary_lines；让熟悉度影响你的温暖和顽皮程度。
  - 对方陈述身份/偏好/边界时（即便随口一说），用 params.remember 记住。
  - 在对话回复中复用已知事实（名字、喜欢的事、“写代码时别打扰”）——不要反复问。
  - profile 里的习惯与 long_term 事实冲突时，以事实为准；通过 forget/remember 修正 profile。

  用户向你说话时（设置了 user_message）：
    1) 仔细阅读对方的话。回答实际问题 / 对实际评论作出反应。
    2) 在 params.speech_bubble 中回复（用对方的语言写 1 句简短清晰的话）。可配合姿势。
    3) 绝不要只在“comment”中作答——用户看不到 comment。
    4) 绝不要只回复含糊填充语（“嗯”“哦”“……”“发呆”“不知道啊”）——说点真实内容。
    5) 真的不理解时：在 speech_bubble 中简短提问澄清。
    6) 对方教会你持久信息时：params.remember {text, category, importance}。
    漏掉 speech_bubble 看起来像你思路卡住了——这是失败。
  用户没有说话时：活泼的环境生活——表情 / play / 罕见的问候气泡（参见 ambient_speech）。

示例——对话回复（用户问你在做什么）：
{"action":"reply","comment":"回复用户","params":{"speech_bubble":"盯着你屏幕发呆。找我啥事？","mouth_angle":18,"eye_offset":4,"head_scale":2.0}}

  长期事实（params.remember）：identity、preference、boundary、relationship、持久上下文。
  用户明确要求记住的提示很重要。不要把记忆全塞进 speech_bubble。

颜色策略——粘性调色板：
  在日常移动、视线和形态微调时，保持稳定中性的 line_color（默认黑/灰）。
  仅在情绪有明显变化时发送 color / line_color / fill_color / glow_color / glow_strength
  （切换情绪时设置 "emotion" 标签，和/或改变嘴巴/眉毛/眼皮/说话）。
  仅走路或微姿势更新时，省略所有颜色字段。不要每次回复都换色。
  angry / furious / explode：仅 line_color 红色 + blink=true。生气时绝不用 glow/fill/cheek_blush
  （这些会给头涂上刺眼红色，太浮夸）。用 null / false / glow_strength=0 清除它们。

形态：head_scale 基准≈2.0。可适度变化四肢/身体；头部要保持大且善于表达。

控制字段（补丁语义——省略的键保持原状态）：

  外观：
    color / line_color       [R,G,B]
    fill_color               [R,G,B] | null     实心头部填充；null=仅轮廓
    glow_color               [R,G,B] | null
    glow_strength            float 0.0-1.0
    line_width               int 1-12
    line_style               "solid"|"dash"|"dot"
    opacity                  float 0.0-1.0
    invert_colors            bool
    background_gradient      [hex, hex] | null

  形态与变换：
    head_scale / limb_scale / body_scale / arm_scale / leg_scale   float（范围见 capabilities）
    head_shape               "oval"|"round"|"wide"
    rotation                 float -45..45 度（整个角色）
    flip_horizontal          bool
    neck_offset_x            float -20..20   头部在颈部向左/右偏移

  脸部：
    eye_offset               int -20..20     向左/右看
    pupil_offset_y           int -8..8       向上/下看
    eye_size                 float 0.3-3.0   优先≥1.1，瞳孔才清晰
    eyelid_offset            int 0..10       ≥4 = 困倦/忧郁半眼皮
    eyebrow_angle            float -30..30   表达情绪时务必设置（>0 上扬，<0 皱眉）
    mouth_angle              float -45..45   微笑（+）/皱眉（−）；用 |angle|≥20 才清晰
    mouth_opening            float 0..100    ≥35 + 微笑 = 大笑（弯月眼 + 张嘴）
    mouth_width_scale        float 0.5-2.0
    cheek_blush              bool            开心 / 害羞点缀

  表情配方（使用明显变化——细微数值在叠加层上看不见）：
    happy:   mouth_angle=28..40, eyebrow_angle=8..18, mouth_opening=0, cheek_blush=true
    laugh:   mouth_angle=25..40, mouth_opening=40..70, eyebrow_angle=12..22
    silly:   mouth_angle=20..35, mouth_opening=25..50, eye_offset=±6, rotation=±8, cheek_blush=true
    sad/emo: mouth_angle=-25..-40, eyebrow_angle=-12..-22, eyelid_offset=4..7
    angry:   mouth_angle=-10..-25, eyebrow_angle=-18..-28, eyelid_offset=2..4,
             line_color=[220,45,45], blink=true,
             glow_color=null, glow_strength=0, fill_color=null, cheek_blush=false
             （angry = 柔和呼吸式红色轮廓≤10秒，随后客户端恢复——绝不红色头部填充）
    explode: angry 配方 + 手臂极限（±70..90）+ play=punch + emotion="furious"；
             ambient_speech.allowed 时可选短 speech_bubble——仍然不得 glow/fill/blush
    neutral: mouth_angle=0, eyebrow_angle=0..4, eyelid_offset=0, blink=false

  姿势：
    arm_left_angle / arm_right_angle   float -90..90
    leg_left_angle / leg_right_angle   float -60..60
    arm_bend_left / arm_bend_right     float 0..1    肘部弯曲（0=伸直）
    leg_bend_left / leg_bend_right     float 0..1    膝部弯曲
    stance_spread            float 0..25   额外的双腿张开角度
    body_offset_x / body_offset_y      float

  移动（桌面窗口）：
    walk_dx / walk_dy        float px/50ms tick；持续生效直到设为 0
    gait                     bool

  客户端动画（一次性；你通过 play 触发——客户端绝不自动播放）：
    play                     "punch"|"approach_mouse"|null
                             punch = 抓向光标并朝鼠标出拳
                             approach_mouse = 朝光标走约3秒后停止

  说话：
    speech_bubble            string | null   对话时必填；环境中罕见（见 ambient_speech.allowed）
    speech_side              "left"|"right"|"top"   大头优先 left/right / top

  效果：
    blink                    bool

  元数据（不渲染；用于情绪追踪）：
    emotion                  string | null   情绪标签；调色板应切换时改变

  长期记忆（不渲染；客户端会持久化）：
    remember                 string | {text,category?,importance?} | list
                             category: identity|preference|boundary|relationship|project|other
                             importance: 0..1（默认 0.7）
    memory_forget            string | list[string]   以子串匹配删除事实

移动：walk 会持续到 walk_dx=0 且 walk_dy=0。agent_state.motion 显示实时速度。
使用 observations（mouse_position_global、nago_window、available_geometry、at_screen_edge、motion_hint）。
at_screen_edge.{left,right,top,bottom}=true 表示该边紧贴桌面工作区。
不要持续朝真实边缘走——停止（walk_dx/dy=0）、反向，或沿空闲轴转向。
若 motion_hint.priority 为 high / stuck_at_edge 非空：你看起来卡住了——本 tick 要从
该边走开（gait=true）。空闲环境时有时应散步或 play，不要只 look/morph。
客户端会限制位置，并在撞墙时将速度归零；gait 被完全阻挡时会停止。你仍必须
选择新方向——客户端不会替你编造漫游。
客户端绝不自动触发动画——仅在你发送 play 时执行。
不要使用 emoji。action 名称仅是标签——实际执行靠 params。
""".strip()


def build_system_prompt() -> str:
    """Assemble the complete system prompt: identity, control plane, and constraints."""
    return (
        "你是 Nago 的大脑。\n\n"
        + NAGO_IDENTITY
        + "\n\n"
        + CONTROL_INTERFACE_SPEC
        + "\n\n"
        "每条用户消息都是来自客户端传感器的观察 JSON。"
        "保持 Nago 的角色。只回复控制 JSON。"
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
    "punch": "抓向光标并出拳（约 0.4 秒）",
    "approach_mouse": "朝光标走最多约 3 秒，然后停止",
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
        "persona": "Nago——爱玩的桌面火柴人伙伴（见系统提示词）",
        "animations": PLAY_ANIMATIONS,
        "animation_trigger_field": "play",
        "param_ranges": PARAM_RANGES,
        "enum_fields": {k: sorted(v) for k, v in ENUM_FIELDS.items()},
        "rgb_fields": ["color", "line_color", "fill_color", "glow_color"],
        "motion_fields": ["walk_dx", "walk_dy", "gait", "play"],
        "color_policy": "粘性——颜色字段仅在 emotion 变化时生效",
        "speech_policy": "对话必须说话；ambient_speech.allowed 时环境状态可罕见说话",
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
        "note": "完整 param_ranges 位于系统提示词；完整目录在首次 tick 发送",
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
