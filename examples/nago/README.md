# nago

Desktop stickman companion demo that sits beside **ton** in this repo.
It is **not** part of the `ton` CLI / session orchestrator — treat it as an
optional example (Chinese prompts allowed here; ton core stays English-only).

## Requirements

- Linux desktop with a display (X11 / Wayland via Qt)
- Python 3.10+
- [PySide6](https://pypi.org/project/PySide6/) + [httpx](https://pypi.org/project/httpx/)
- An OpenAI-compatible chat endpoint (Ollama, DeepSeek, …)

Optional: `xprintidle` for better idle detection; `zenity` / `kdialog` if you
set `NAGO_TALK_INPUT=external`.

## Setup

```bash
cd examples/nago
python3 -m pip install -r requirements.txt
cp nago.local.env.example nago.local.env
# edit nago.local.env — set NAGO_AI_ENDPOINT / NAGO_AI_API_KEY / NAGO_AI_MODEL
```

## Run

```bash
# preferred: stops any previous instance, then starts
./nago

# or
python3 main.py
```

Local state (gitignored): `nago.local.env`, `nago.session.json`,
`nago.memory.json`, `nago.profile.json`.

## Relation to ton

| | ton | nago |
| --- | --- | --- |
| Role | Coding-agent session orchestrator (Go TUI) | Ambient desktop companion (Python) |
| Coupling | None required | Shares the monorepo for demos only |

If you only want the orchestrator, ignore this directory.
