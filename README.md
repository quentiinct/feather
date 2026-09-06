# Feather

Hold a shortcut, speak, and the text lands in whatever window has focus — your editor,
your browser, a chat box, a search field. Transcription runs entirely on your machine
through [whisper.cpp](https://github.com/ggml-org/whisper.cpp). No account, no API key,
no audio ever leaves the computer.

Feather is an offline alternative to [Wispr Flow](https://wisprflow.ai).

> The interface is in French, and the default transcription language is French. Whisper
> itself is multilingual — change the language under **Transcription**.

---

## Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Install](#install)
- [Using it](#using-it)
- [How it works](#how-it-works)
- [Performance](#performance)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Building a release](#building-a-release)
- [Data and privacy](#data-and-privacy)
- [License](#license)

---

## What it does

**One shortcut, anywhere.** Two modifier keys — `Ctrl + Shift` by default, any pair of
Ctrl / Shift / Alt / Win. Tap to start and tap again to stop, or hold them down for
push-to-talk. It coexists with your existing shortcuts: press a third key on top
(`Ctrl + Shift + T`) and Feather cancels silently without writing anything.

**Local, fast transcription.** whisper.cpp with CUDA acceleration when an NVIDIA card is
present. The model stays resident in video memory between dictations, so a phrase comes
back in roughly 200 ms rather than the two seconds a cold model load would cost.

**Speech turned into writing.** Whisper is faithful, but speech is not prose. Feather
strips fillers and stutters, fixes spacing and capitalisation, applies French typography
rules, and runs your personal dictionary over the proper nouns and jargon it keeps
getting wrong.

**Spoken line breaks.** Say *« à la ligne »*, *« nouveau paragraphe »* or *« point à la
ligne »* and you get a real line break instead of the words.

**Text delivered anywhere.** Clipboard paste by default, with your previous clipboard
contents restored immediately afterwards; per-character Unicode typing as a fallback for
fields that refuse pastes.

**Feedback that stays out of the way.** A floating pill shows the input level and a
timer while you speak, and two short tones mark the start and end of a recording. The
pill never takes focus — a window that stole focus would receive the paste instead of
your editor.

**Statistics.** Words dictated, time saved versus typing, speaking rate, daily streak,
and a 30-day chart you can read as bars, a line, or a table.

---

## Requirements

| | |
|---|---|
| OS | Windows 10 or 11, x64 |
| Node.js | 20 or newer, to run from source |
| GPU | Optional. An NVIDIA card with CUDA 12 makes it roughly ten times faster |
| Disk | ~600 MB for the CUDA build, plus 500 MB–1.5 GB per model |
| Memory | ~2 GB of VRAM with the recommended model |

Without a GPU everything still works — pick the `Small` model and expect a couple of
seconds per phrase instead of a fraction of one.

---

## Install

```bash
git clone https://github.com/quentiinct/feather.git
cd feather
npm install
npm run setup     # downloads whisper.cpp and the default model
npm start
```

`npm run setup` detects your GPU and picks the matching build:

| Command | Effect |
|---|---|
| `npm run setup` | CUDA build if an NVIDIA card is found, CPU build otherwise |
| `npm run setup -- --cpu` | force the CPU build (8 MB instead of 640 MB) |
| `npm run setup -- --cuda` | force the CUDA 12.4 build |
| `npm run setup -- --model ggml-small` | choose another model |
| `npm run setup -- --model-only` | re-download the model only |

### Models

| Model | Size | Notes |
|---|---|---|
| `ggml-small` | 488 MB | Sensible choice on CPU only |
| `ggml-medium` | 1.5 GB | Accurate, slow without a GPU |
| `ggml-large-v3-turbo-q5_0` | 574 MB | **Recommended.** Best quality per millisecond |
| `ggml-large-v3-q5_0` | 1.1 GB | Highest quality; wants a GPU to stay comfortable |

Models are downloaded from Hugging Face into `%APPDATA%\Feather\models\`, checked
against their expected size and GGML magic number, and written atomically — an
interrupted download can never leave a half-file that fails later at dictation time.

---

## Using it

| Action | Result |
|---|---|
| Tap both modifiers | Start recording; tap again to stop and insert |
| Hold both modifiers | Record while held, insert on release |
| Press a third key | Cancel — your existing shortcut goes through untouched |
| `Esc` while recording | Discard the recording |
| Close the window | Feather keeps running in the notification area |

Feather lives in the system tray. Closing the settings window hides it rather than
quitting; quit from the tray menu.

### Spoken commands

| You say | You get |
|---|---|
| « à la ligne », « retour à la ligne » | a line break |
| « point à la ligne » | a full stop, then a line break |
| « nouveau paragraphe », « nouvelle ligne » | a blank line |

They are only interpreted when they stand alone as a command. "Je pense à la ligne
budgétaire" keeps its words, because a word or a digit following the phrase suppresses
the substitution.

---

## How it works

```
   Ctrl + Shift            uiohook-napi, low-level keyboard hook
        │                  Electron cannot register modifier-only shortcuts
        ▼
   hidden window           microphone stays open, 16 kHz mono PCM
        │                  reopening it per dictation would blink the OS
        ▼                  indicator and clip the first words
   WAV in %TEMP%
        │
        ▼
   whisper-server          resident HTTP server, model held in VRAM
        │   └─ fallback    whisper-cli, ~2 s, used if the server is not ready
        ▼
   cleanup rules           fillers, stutters, spacing, capitalisation,
        │                  typography, dictionary, spoken line breaks
        ▼
   injection               clipboard paste + Ctrl+V, through a persistent
        │                  PowerShell SendInput helper
        ▼
   your application
```

A few decisions worth explaining:

**The shortcut uses a keyboard hook, not `globalShortcut`.** Electron cannot register a
combination of modifiers alone. As soon as both modifiers are down, capture starts
silently; it is only confirmed after 160 ms, which is the window in which a third key
may still arrive and turn the gesture into an ordinary shortcut.

**whisper.cpp runs as a server, not a command.** Every `whisper-cli` invocation reloads
the model — about two seconds for `large-v3-turbo-q5`. Feather keeps `whisper-server`
alive and posts the WAV to it over local HTTP instead. The model is preloaded at startup
so the very first dictation is already fast.

**Server startup never blocks a dictation.** Starting the server is a background task. A
dictation waits at most 2.5 seconds for it, then takes the CLI path while the model
finishes loading; the next dictation finds the server ready. Cold CUDA initialisation
can take up to a minute on the first run after a reboot, and this is what keeps that
minute invisible.

**The model is unloaded when idle.** After 30 minutes without a dictation the server
stops and hands the VRAM back. The next dictation then costs one CLI round trip (~2 s)
while the model reloads. Set `whisper.serverIdleMinutes` to `0` to keep it resident
permanently.

**Injection goes through a persistent PowerShell process.** Compiling the Win32 interop
costs about a second; paying that per dictation would be unusable. The helper starts
once and answers in about a millisecond afterwards.

**The overlay is never focusable.** Anything else would receive the paste instead of
your editor.

---

## Performance

Measured on an RTX 3060 (12 GB) with `large-v3-turbo-q5`, on eight seconds of speech:

| Situation | Latency |
|---|---|
| Server warm | 180–330 ms |
| First dictation after an idle unload | ~1.9 s |
| The one after that | ~180 ms |
| First server start after a reboot | up to 80 s, in the background |

The dominant cost on a cold machine is CUDA context creation, not Whisper itself. That
is why the server is started at launch and then kept alive.

---

## Configuration

The settings window covers what you change day to day:

| Panel | Contains |
|---|---|
| **Tableau de bord** | Statistics and the 30-day chart |
| **Général** | Theme, overlay, sound feedback, start with Windows, updates, data folder |
| **Raccourci** | Modifier keys, toggle or hold, hold threshold |
| **Micro** | Input device, level meter, maximum duration, silence threshold |
| **Transcription** | Model, language, GPU, context prompt, personal dictionary |

Everything else lives in `%APPDATA%\Feather\config.json`, plain JSON merged over the
defaults in [`src/shared/defaults.js`](src/shared/defaults.js):

| Key | Default | Purpose |
|---|---|---|
| `output.mode` | `paste` | `type` writes character by character, for fields that refuse pastes |
| `output.restoreClipboard` | `true` | Puts your clipboard back after pasting |
| `output.appendSpace` | `true` | Trailing space, so dictations chain naturally |
| `whisper.serverIdleMinutes` | `30` | `0` keeps the model in VRAM permanently |
| `whisper.initialPrompt` | `""` | A few words of your jargon sharpen proper nouns |
| `cleanup.rules.*` | all on | The individual cleanup passes |
| `cleanup.mode` | `rules` | `llm` routes text through a local Ollama model; `off` disables cleanup |
| `history.maxEntries` | `200` | Local transcript history |
| `audio.silenceThreshold` | `0.006` | Raise it if empty dictations get through |

The `llm` cleanup mode has no interface. It sends the transcript to a local
[Ollama](https://ollama.com) model for a finer rewrite — handling self-corrections like
"Tuesday, no, Friday" — falls back to the rule-based pass on any error or timeout, and
still costs nothing and stays offline.

---

## Architecture

```
src/
  main/                    Electron main process
    index.js               lifecycle, windows, tray, dictation pipeline
    config.js              persisted settings, merged over the defaults
    stats.js               counters, daily series, transcript history
    hotkey.js              modifier-only shortcut via a low-level hook
    whisper.js             whisper.cpp driver: server, CLI fallback, idle unload
    cleanup.js             rule-based cleanup, spoken line breaks, dictionary
    injector.js            text insertion into the focused application
    downloader.js          downloads with progress and verification
    install-binaries.js    whisper.cpp installation
    updater.js             electron-updater wiring
  preload/bridge.js        IPC bridge, one explicit allowlist per direction
  renderer/
    capture/               hidden window: microphone, 16 kHz PCM, WAV encoding
    overlay/               floating pill shown while dictating
    settings/              settings and statistics
    fonts/                 bundled Google Sans Flex and Sansation subsets
resources/inject.ps1       Win32 SendInput helper, kept alive
scripts/                   whisper.cpp setup, icon generation
```

The renderer is sandboxed the usual way: `contextIsolation` on, `nodeIntegration` off,
and a Content-Security-Policy that allows no remote origin at all. Fonts are bundled
rather than fetched, for exactly that reason. Every IPC channel is listed explicitly in
[`src/preload/bridge.js`](src/preload/bridge.js) — invoke, send and receive each have
their own allowlist.

### Design system

Three colours, applied across both themes: Coconut White `#F2F1EA`, Obsidian Ink
`#151311`, Velvet Curfew `#4B262F`. Dark mode is authored rather than derived — its
values are chosen separately, not flipped. Chart marks use a lighter step of the same
hue, because Velvet Curfew sits below the readable lightness band for a data mark.

Icons come from `npm run icons`, generated from a single geometry — a feather whose
barbs are the bars of a waveform — with fewer, thicker barbs at small sizes so the shape
survives at 16 px. No image dependency: the script encodes the PNG and the ICO itself.

---

## Building a release

```bash
npm run build     # NSIS installer, in dist/
npm run pack      # unpacked directory, for a quick check
npm run release   # build and publish to GitHub Releases
```

Updates go through `electron-updater` against GitHub Releases: the app checks at launch
and every six hours, downloads in the background, notifies you, and installs on quit —
nothing to reinstall by hand. This only works once the repository and its releases are
public.

---

## Data and privacy

No network call is made during normal operation. The only outbound requests Feather ever
makes are the model downloads you trigger and the update check.

Everything is stored in `%APPDATA%\Feather\` (**Général → Ouvrir** opens it):

| File | Contents |
|---|---|
| `config.json` | Settings |
| `stats.json` | Counters and daily series |
| `history.json` | Local transcript history |
| `models/` | Downloaded GGML models |

Audio is written to a temporary WAV file, handed to the local engine, and deleted
immediately afterwards — unless you set `privacy.keepAudioFiles` for debugging.

---

## License

MIT. See [LICENSE](LICENSE).
