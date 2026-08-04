# nago

**English** | [简体中文](README.zh-CN.md)

Always-on-top stickman desktop companion (Python / PySide6). Demo under
`extras/nago` — separate from the `ton` CLI.

## Requirements

| Need | Notes |
| --- | --- |
| Linux desktop | `DISPLAY` or `WAYLAND_DISPLAY` |
| Python 3.10+ | `python3` on `PATH` |
| Deps | [PySide6](https://pypi.org/project/PySide6/), [httpx](https://pypi.org/project/httpx/) |
| LLM | OpenAI-compatible `…/v1/chat/completions` |

Optional: `xprintidle` (idle detection); `zenity` / `kdialog` if
`NAGO_TALK_INPUT=external`.

## Quick start

```bash
cd extras/nago
python3 -m pip install -r requirements.txt
cp nago.local.env.example nago.local.env
# set NAGO_AI_ENDPOINT / NAGO_AI_API_KEY / NAGO_AI_MODEL
./nago
```

`./nago` restarts cleanly (stops any previous instance). Or: `python3 main.py`.

## Configuration

Edit `nago.local.env` (from the example; gitignored):

| Variable | Purpose |
| --- | --- |
| `NAGO_AI_ENDPOINT` | chat/completions URL |
| `NAGO_AI_API_KEY` | API key |
| `NAGO_AI_MODEL` | Model id |
| `NAGO_AI_TIMEOUT` | Timeout (seconds) |
| `NAGO_TALK_INPUT` | `qt` · `external` · `auto` |
| `NAGO_HEARTBEAT_MS` | Ambient poll when idle |
| `NAGO_SPEECH_BUBBLE_MS` | Bubble auto-dismiss |
| `NAGO_MIN_SPEECH_GAP_SEC` | Min gap between ambient lines |

Full comments: `nago.local.env.example`.

## Features

- Transparent always-on-top stickman (drag to move)
- Ambient loop: sensors → model → expression / bubble
- Talk mode with on-screen composer
- Local session / memory / profile JSON

## Local state (gitignored)

`nago.local.env`, `nago.session.json`, `nago.memory.json`, `nago.profile.json`

## Tests

```bash
cd extras/nago
python3 -m pytest test_integration.py -q
# or: python3 test_integration.py
```

## Troubleshooting

| Symptom | Try |
| --- | --- |
| No `DISPLAY` / Wayland | Run in a desktop session |
| No window | Check `~/.cache/nago/nago.log`; confirm PySide6 |
| No model replies | Verify `NAGO_AI_*`; probe the endpoint with `curl` |
| Stuck instance | Run `./nago` again, or remove `/tmp/nago-stickman.lock` |

See also: [ton README](../../README.md).
