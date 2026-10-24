# pi-sounds

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Pi extension](https://img.shields.io/badge/pi-extension-blueviolet.svg)](https://pi.dev)

Notification sounds for [Pi](https://pi.dev): know when a run finishes, fails, asks you something, or gets interrupted — without watching the terminal.

Works on Linux, macOS, and anywhere Pi runs. Uses whatever audio player is already installed and falls back to the terminal bell, so it never becomes a hard dependency.

## Features

- **Four events** — `done`, `error`, `question`, and `aborted`, each with its own sound file and volume.
- **Settled, not ended** — the extension hooks `agent_settled`, so retries and queued continuations never announce a run that is still in flight.
- **Player autodetection** — picks the first working binary from `pw-play`, `paplay`, `ffplay`, `mpv`, `aplay`, `afplay`; `cvlc` and `bell` are available by name.
- **Per-event rules** — sound name or path, volume, player, and an on/off switch for every event, with a cooldown against repeats.
- **Bluetooth lead-in** — prepends digital silence so a sleeping A2DP sink does not clip the first hit; generated once and cached.
- **Bell fallback** — a missing player or sound file degrades to the terminal bell and never blocks a run.
- **Config layering** — env var, project, then global file; `/sounds on|off` and `--no-sounds` override per session.

## Events

| Event | Fires when |
|---|---|
| `done` | The run fully settled and Pi is waiting for input again (success). |
| `error` | The run ended in a final error, after automatic retries were exhausted. |
| `question` | The model opened a questionnaire and is waiting for your answer. |
| `aborted` | The run was interrupted (Esc / abort). |

`pi-sounds` hooks `agent_settled` instead of `agent_end` on purpose: `agent_end` fires before automatic retries, auto-compaction retries and queued continuations, so it would announce runs that are still in flight. Retries re-emit `agent_start`, which cancels the pending outcome — a retried attempt never plays the error sound and never leaves a stale error behind.

## Requirements

- [Pi](https://pi.dev) with extension support.
- One audio player (optional, but recommended): `pw-play`, `paplay`, `ffplay`, `mpv`, `aplay`, `afplay`, `cvlc`.
- `ffmpeg` — only for the Bluetooth lead-in (see [Bluetooth lead-in](#bluetooth-lead-in)). Without it sounds still play, just unpadded.

No build step and no runtime dependencies: Pi loads the TypeScript entry point directly.

## Installation

```sh
pi install git:github.com/TolyanL/pi-sounds
```

Pin a tag or commit:

```sh
pi install git:github.com/TolyanL/pi-sounds@v1.0.0
```

Try it for a single invocation without touching your settings:

```sh
pi -e git:github.com/TolyanL/pi-sounds
```

From a local clone:

```sh
git clone https://github.com/TolyanL/pi-sounds
pi install ./pi-sounds
```

Restart Pi, or run `/reload`, after changing the extension. The package is `npm`-shaped (`keywords: ["pi-package"]`), so `pi install npm:pi-sounds` works the same way if you publish it.

## Usage

```sh
pi                 # start Pi
pi --no-sounds     # start with sounds disabled
```

Inside Pi:

```text
/sounds            # print current state: on/off, player, lead-in, config file in use
/sounds on         # enable sounds for this session
/sounds off        # disable sounds for this session
```

`/sounds on` and `/sounds off` store their state in the session, so it survives `/resume` and `/reload`.

## Sound files

Sounds are looked up by name in `soundsDir` (default `~/.pi/sounds`). Any file whose stem matches the rule's `sound` value and whose extension is one of `ogg`, `oga`, `wav`, `mp3`, `flac`, `m4a`, `opus`, `aac` is used:

```text
~/.pi/sounds/
├── done.mp3
├── error.mp3
├── question.mp3
└── aborted.mp3
```

A `sound` value containing `/` (or an absolute path) is loaded directly, so rules can point at any file:

```json
{ "events": { "done": { "sound": "/home/me/audio/ding.wav" } } }
```

The special value `bell` skips playback entirely and rings the terminal bell. A missing file is reported once as a notification and also degrades to the bell — it never blocks a run.

## Configuration

The first existing file wins:

1. `$PI_SOUNDS_CONFIG`
2. `<project>/.pi/sounds.json` — only in a trusted project
3. `~/.pi/agent/sounds.json`

Missing or malformed files are ignored with a one-line warning; built-in defaults are used instead. A full configuration:

```json
{
  "enabled": true,
  "player": "auto",
  "volume": 0.8,
  "cooldownMs": 1000,
  "stopPrevious": false,
  "soundsDir": "~/.pi/sounds",
  "leadInMs": "auto",
  "bluetoothLeadInMs": 400,
  "events": {
    "done": { "enabled": true, "sound": "done", "volume": 0.7 },
    "error": { "enabled": true, "sound": "error", "volume": 0.9 },
    "question": { "enabled": true, "sound": "question", "volume": 0.8 },
    "aborted": { "enabled": true, "sound": "aborted", "volume": 0.7 }
  },
  "question": {
    "tools": ["ask_user_question"],
    "uiPrompts": false,
    "eventChannels": []
  },
  "errors": {
    "stopReasons": ["error"]
  }
}
```

[`examples/sounds.json`](examples/sounds.json) is a ready-to-copy version that additionally turns on `stopPrevious` and subscribes to the rpiv questionnaire channel.

### Top-level options

| Option | Default | Description |
|---|---|---|
| `enabled` | `true` | Master switch. `/sounds off` and `--no-sounds` override it per session. |
| `player` | `"auto"` | Player name, `"auto"`, `"bell"`, or `"off"`. |
| `volume` | `0.8` | Default volume, `0`–`1`. Per-event rules can override it. |
| `cooldownMs` | `1000` | Minimum gap between two sounds of the same event. |
| `stopPrevious` | `false` | Stop still-playing sounds before starting a new one. |
| `soundsDir` | `"~/.pi/sounds"` | Directory searched for named sound files. |
| `leadInMs` | `"auto"` | Silence prepended before playback, or `"auto"`. |
| `bluetoothLeadInMs` | `400` | Lead-in used by `"auto"` when the default sink is Bluetooth. |

### Event rules

Each key in `events` accepts either a sound name or an object:

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Turn this event off. |
| `sound` | event name | Sound name, path, or `"bell"`. |
| `volume` | top-level `volume` | Volume for this event, `0`–`1`. |
| `player` | top-level `player` | Override the player for this event. |

### Question detection

| Option | Default | Description |
|---|---|---|
| `question.tools` | `["ask_user_question"]` | Tool names that put Pi into a waiting-for-you state. |
| `question.uiPrompts` | `false` | Also fire for generic extension dialogs (`ui_prompt_start`). |
| `question.eventChannels` | `[]` | Extra event-bus channels announcing a blocked prompt. |

Channels added to `question.eventChannels` are treated as "question active" unless the payload carries `{ "active": false }`, which resets the waiting flag. For the rpiv questionnaire, `"rpiv:ask-user:blocked"` is the useful channel.

### Error detection

| Option | Default | Description |
|---|---|---|
| `errors.stopReasons` | `["error"]` | Assistant `stopReason` values treated as final errors. |

## Players

`"player": "auto"` picks the first available binary in this order: `pw-play`, `paplay`, `ffplay`, `mpv`, `aplay`, `afplay`. `cvlc` and `bell` are available by name only.

Built-in argument templates:

| Player | Args |
|---|---|
| `pw-play` | `{file}` |
| `paplay` | `{file}` |
| `ffplay` | `-nodisp -autoexit -loglevel quiet -volume {volume100} {file}` |
| `mpv` | `--no-video --really-quiet --volume={volume100} {file}` |
| `aplay` | `-q {file}` |
| `afplay` | `-v {volume} {file}` |
| `cvlc` | `--play-and-exit --intf dummy {file}` |
| `bell` | — (writes `\a` to the terminal) |

Override or add a player with the `players` key; an entry with the same name replaces the built-in one:

```json
{
  "players": {
    "pw-play": { "command": "pw-play", "args": ["--volume", "{volume}", "{file}"] },
    "bell": { "command": null, "args": [] }
  }
}
```

Placeholders: `{file}`, `{volume100}` (0–100), `{volume}` (0.00–1.00). `"command": null` means the terminal bell instead of a subprocess.

## Bluetooth lead-in

A sink that went to sleep — Bluetooth A2DP in particular — needs roughly 150–400 ms to wake up and silently drops whatever is played during that window, which clips the first hit of the sound.

With `leadInMs: "auto"`, Pi queries the default sink via `pactl get-default-sink` (result cached for 30 s) and prepends `bluetoothLeadInMs` of real digital silence to Bluetooth sinks. The padded file is generated once with `ffmpeg`, cached under `$XDG_CACHE_HOME/pi-sounds` (or `~/.cache/pi-sounds`), and keyed by source size, mtime and lead-in. If anything in that chain fails, the original file is played as-is.

Set a positive number to force a lead-in, or `0` to disable it.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Only the terminal bell rings | No player found — install one from the list above, or set `player` explicitly. |
| Nothing at all | Check `/sounds`; a missing sound file or an unavailable player is reported once as a warning. |
| Sound is clipped at the start | Bluetooth sink; keep `leadInMs: "auto"` and install `ffmpeg`. |
| Sounds overlap or cut each other | Set `stopPrevious: true`, or raise `cooldownMs`. |
| Question sound never fires | Add your questionnaire's tool name to `question.tools`, or its channel to `question.eventChannels`. |

## Limitations

- Sounds are fired per event, not per message: a long run with several tool calls is still one `done`.
- Only the session toggle is persisted by the extension; the player, volume, and per-event rules come from the config file.
- The Bluetooth lead-in depends on `pactl` and `ffmpeg`; without either, the original file is played unchanged.

## Development

The extension entry point is `index.ts`; Pi loads TypeScript directly, so there is no build step. Point Pi at a clone and reload after edits:

```sh
pi install ./pi-sounds   # or: pi -e ./pi-sounds
```

Useful entry points in `index.ts`:

- `DEFAULT_CONFIG` — every default value.
- `mergeConfig` — config parsing and validation.
- `PLAYER_DEFAULTS` — player command templates.
- `paddedFile` — lead-in generation and cache.
- `pi.on("agent_settled" | "agent_end" | "tool_call" | …)` — event wiring.

## License

[MIT](LICENSE) © TolyanL
