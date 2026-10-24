/**
 * pi-sounds — notification sounds for pi.
 *
 * Plays a sound when:
 *   done     — the run fully settled and pi is waiting for input (agent_settled, ok outcome)
 *   error    — the run ended in a final error, after retries are exhausted
 *   question — the model opened the rpiv questionnaire (ask_user_question)
 *   aborted  — the run was interrupted (Esc / abort)
 *
 * Why agent_settled instead of agent_end: agent_end fires before automatic retries,
 * auto-compaction retries and queued continuations. The failed assistant message of a
 * retried attempt is removed from agent state but kept in session history, so inspecting
 * session history would report a stale error. We track the outcome from the events instead:
 * every retry re-emits agent_start, which cancels the pending error outcome.
 *
 * Config (first existing file wins):
 *   $PI_SOUNDS_CONFIG  →  <cwd>/.pi/sounds.json (trusted projects)  →  ~/.pi/agent/sounds.json
 *
 * A Bluetooth default sink gets `leadInMs` of real silence in front of every sound:
 * A2DP takes 150-400 ms to wake up and drops the audio played during that window.
 *
 * The question sound is driven only by the rpiv questionnaire: its tool and its
 * `rpiv:ask-user:blocked` event. Generic blocking dialogs of other extensions are
 * ignored unless `question.uiPrompts` is turned on explicitly.
 *
 * Commands: /sounds on | /sounds off  (session-scoped, restored on /resume and /reload)
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type SoundEvent = "done" | "error" | "question" | "aborted";
type Outcome = "ok" | "error" | "aborted";

interface EventRule {
  enabled: boolean;
  sound: string;
  volume?: number;
  player?: string;
}

interface PlayerDef {
  /** null means "terminal bell instead of a subprocess". */
  command: string | null;
  args: string[];
}

interface SoundsConfig {
  enabled: boolean;
  player: string;
  volume: number;
  cooldownMs: number;
  stopPrevious: boolean;
  soundsDir: string;
  /**
   * Silence prepended before playback. A sink that went to sleep (Bluetooth A2DP in
   * particular) needs 150-400 ms to wake up and drops whatever is played during that
   * window, which clips the attack of the sound. Padding with real silence moves the
   * loss into the silence. "auto" = `bluetoothLeadInMs` on a Bluetooth default sink, else 0.
   */
  leadInMs: number | "auto";
  bluetoothLeadInMs: number;
  events: Record<SoundEvent, EventRule>;
  question: {
    tools: string[];
    uiPrompts: boolean;
    eventChannels: string[];
  };
  errors: {
    stopReasons: string[];
  };
}

interface ResolvedPlayer {
  name: string;
  def: PlayerDef;
}

const EVENT_NAMES: SoundEvent[] = ["done", "error", "question", "aborted"];
const AUDIO_EXTENSIONS = ["ogg", "oga", "wav", "mp3", "flac", "m4a", "opus", "aac"];
const STATE_ENTRY = "pi-sounds";

/** Players tried by `"player": "auto"`, in order. */
const AUTO_PLAYERS = ["pw-play", "paplay", "ffplay", "mpv", "aplay", "afplay"];

/** Built-in player definitions; a `players` entry in the config replaces one by name. */
const PLAYER_DEFAULTS: Record<string, PlayerDef> = {
  "pw-play": { command: "pw-play", args: ["{file}"] },
  paplay: { command: "paplay", args: ["{file}"] },
  ffplay: {
    command: "ffplay",
    args: ["-nodisp", "-autoexit", "-loglevel", "quiet", "-volume", "{volume100}", "{file}"],
  },
  mpv: { command: "mpv", args: ["--no-video", "--really-quiet", "--volume={volume100}", "{file}"] },
  aplay: { command: "aplay", args: ["-q", "{file}"] },
  afplay: { command: "afplay", args: ["-v", "{volume}", "{file}"] },
  cvlc: { command: "cvlc", args: ["--play-and-exit", "--intf", "dummy", "{file}"] },
  bell: { command: null, args: [] },
};

const DEFAULT_CONFIG: SoundsConfig = {
  enabled: true,
  player: "auto",
  volume: 0.8,
  cooldownMs: 1000,
  stopPrevious: false,
  soundsDir: "~/.pi/sounds",
  leadInMs: "auto",
  bluetoothLeadInMs: 400,
  events: {
    done: { enabled: true, sound: "done", volume: 0.7 },
    error: { enabled: true, sound: "error", volume: 0.9 },
    question: { enabled: true, sound: "question", volume: 0.8 },
    aborted: { enabled: true, sound: "aborted", volume: 0.7 },
  },
  question: { tools: ["ask_user_question"], uiPrompts: false, eventChannels: [] },
  errors: { stopReasons: ["error"] },
};

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeRule(value: unknown, fallback: EventRule): EventRule {
  if (typeof value === "string") return { ...fallback, sound: value };
  if (value && typeof value === "object") {
    const raw = value as Record<string, unknown>;
    const rule: EventRule = { ...fallback };
    if (typeof raw.enabled === "boolean") rule.enabled = raw.enabled;
    if (typeof raw.sound === "string") rule.sound = raw.sound;
    if (typeof raw.volume === "number") rule.volume = raw.volume;
    if (typeof raw.player === "string") rule.player = raw.player;
    return rule;
  }
  return { ...fallback };
}

function mergeConfig(raw: unknown): SoundsConfig {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const events = {} as Record<SoundEvent, EventRule>;
  const rawEvents = (
    source.events && typeof source.events === "object" ? source.events : {}
  ) as Record<string, unknown>;
  for (const name of EVENT_NAMES) {
    events[name] = normalizeRule(rawEvents[name], DEFAULT_CONFIG.events[name]);
  }

  const question = (
    source.question && typeof source.question === "object" ? source.question : {}
  ) as Record<string, unknown>;
  const errors = (
    source.errors && typeof source.errors === "object" ? source.errors : {}
  ) as Record<string, unknown>;
  const players = (
    source.players && typeof source.players === "object" ? source.players : {}
  ) as Record<string, unknown>;
  const mergedPlayers: Record<string, PlayerDef> = { ...PLAYER_DEFAULTS };
  for (const [name, def] of Object.entries(players)) {
    if (def && typeof def === "object") {
      const raw = def as Record<string, unknown>;
      mergedPlayers[name] = {
        command: raw.command === null ? null : typeof raw.command === "string" ? raw.command : null,
        args: asStringArray(raw.args, []),
      };
    }
  }

  return {
    enabled: asBool(source.enabled, DEFAULT_CONFIG.enabled),
    player: asString(source.player, DEFAULT_CONFIG.player),
    volume: asNumber(source.volume, DEFAULT_CONFIG.volume),
    cooldownMs: asNumber(source.cooldownMs, DEFAULT_CONFIG.cooldownMs),
    stopPrevious: asBool(source.stopPrevious, DEFAULT_CONFIG.stopPrevious),
    soundsDir: asString(source.soundsDir, DEFAULT_CONFIG.soundsDir),
    leadInMs:
      source.leadInMs === "auto"
        ? "auto"
        : typeof source.leadInMs === "number" && Number.isFinite(source.leadInMs)
          ? Math.max(0, source.leadInMs)
          : DEFAULT_CONFIG.leadInMs,
    bluetoothLeadInMs: Math.max(
      0,
      asNumber(source.bluetoothLeadInMs, DEFAULT_CONFIG.bluetoothLeadInMs),
    ),
    events,
    question: {
      tools: asStringArray(question.tools, DEFAULT_CONFIG.question.tools),
      uiPrompts: asBool(question.uiPrompts, DEFAULT_CONFIG.question.uiPrompts),
      eventChannels: asStringArray(question.eventChannels, DEFAULT_CONFIG.question.eventChannels),
    },
    errors: {
      stopReasons: asStringArray(errors.stopReasons, DEFAULT_CONFIG.errors.stopReasons),
    },
    players: mergedPlayers,
  };
}

function configCandidates(ctx?: ExtensionContext): string[] {
  const paths: string[] = [];
  const fromEnv = process.env.PI_SOUNDS_CONFIG;
  if (fromEnv && fromEnv.length > 0) paths.push(expandHome(fromEnv));
  if (ctx && ctx.isProjectTrusted()) paths.push(join(ctx.cwd, CONFIG_DIR_NAME, "sounds.json"));
  paths.push(join(homedir(), CONFIG_DIR_NAME, "agent", "sounds.json"));
  return paths;
}

function loadConfig(ctx?: ExtensionContext): { config: SoundsConfig; path?: string } {
  for (const path of configCandidates(ctx)) {
    if (!existsSync(path)) continue;
    try {
      return { config: mergeConfig(JSON.parse(readFileSync(path, "utf8"))), path };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`pi-sounds: ignoring ${path}: ${message}\n`);
    }
  }
  return { config: mergeConfig(undefined) };
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

export default function piSounds(pi: ExtensionAPI): void {
  let config = mergeConfig(undefined);
  let configPath: string | undefined;
  let muted = false;
  let ready = false;
  let outcome: Outcome | undefined;
  let waiting = false;

  const playerCache = new Map<string, ResolvedPlayer | null>();
  const soundCache = new Map<string, string | null>();
  const children = new Set<ChildProcess>();
  const lastFired = new Map<SoundEvent, number>();
  const warned = new Set<string>();
  let busUnsubscribers: Array<() => void> = [];

  // -- diagnostics ---------------------------------------------------------

  function notifyOnce(ctx: ExtensionContext, key: string, message: string): void {
    if (warned.has(key)) return;
    warned.add(key);
    try {
      ctx.ui.notify(message, "warning");
    } catch {
      // notifications are best-effort
    }
  }

  // -- players -------------------------------------------------------------

  function commandExists(command: string): boolean {
    if (command.includes("/")) return existsSync(expandHome(command));
    const searchPath = process.env.PATH ?? "";
    for (const dir of searchPath.split(":")) {
      if (dir.length > 0 && existsSync(join(dir, command))) return true;
    }
    return false;
  }

  function resolvePlayer(name: string): ResolvedPlayer | null {
    if (name === "off") return null;
    if (name === "bell") return { name: "bell", def: { command: null, args: [] } };
    const def = config.players[name];
    if (!def || !def.command || !commandExists(def.command)) return null;
    return { name, def };
  }

  function playerFor(name: string): ResolvedPlayer | null {
    const cached = playerCache.get(name);
    if (cached !== undefined) return cached;
    let resolved: ResolvedPlayer | null;
    if (name === "auto") {
      resolved = null;
      for (const candidate of AUTO_PLAYERS) {
        const def = config.players[candidate];
        if (def && def.command && commandExists(def.command)) {
          resolved = { name: candidate, def };
          break;
        }
      }
    } else {
      resolved = resolvePlayer(name);
    }
    playerCache.set(name, resolved);
    return resolved;
  }

  function renderArgs(player: ResolvedPlayer, file: string, volume: number): string[] {
    return player.def.args.map((arg) =>
      arg
        .replaceAll("{file}", file)
        .replaceAll("{volume100}", String(Math.round(volume * 100)))
        .replaceAll("{volume}", volume.toFixed(2)),
    );
  }

  // -- sound files ---------------------------------------------------------

  function findSoundFile(name: string): string | null {
    const expanded = expandHome(name);
    if (isAbsolute(expanded) || expanded.includes("/")) {
      return existsSync(expanded) ? expanded : null;
    }
    const directory = expandHome(config.soundsDir);
    const wanted = name.toLowerCase();
    try {
      for (const entry of readdirSync(directory)) {
        const dot = entry.lastIndexOf(".");
        if (dot <= 0) continue;
        const stem = entry.slice(0, dot).toLowerCase();
        const extension = entry.slice(dot + 1).toLowerCase();
        if (stem === wanted && AUDIO_EXTENSIONS.includes(extension)) {
          return join(directory, entry);
        }
      }
    } catch {
      // missing soundsDir falls through to the bell
    }
    return null;
  }

  function soundFor(event: SoundEvent, rule: EventRule): string | null {
    const key = `${event}\u0000${rule.sound}`;
    const cached = soundCache.get(key);
    if (cached !== undefined) return cached;
    const resolved = rule.sound === "bell" ? null : findSoundFile(rule.sound);
    soundCache.set(key, resolved);
    return resolved;
  }

  // -- sink wake-up lead-in ------------------------------------------------

  let sinkProbe: { at: number; bluetooth: boolean } | undefined;

  function defaultSinkIsBluetooth(): boolean {
    const now = Date.now();
    if (sinkProbe && now - sinkProbe.at < 30_000) return sinkProbe.bluetooth;
    let bluetooth = false;
    try {
      const sink = execFileSync("pactl", ["get-default-sink"], {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      bluetooth = /^bluez/i.test(sink.trim());
    } catch {
      bluetooth = false;
    }
    sinkProbe = { at: now, bluetooth };
    return bluetooth;
  }

  function leadInFor(): number {
    if (config.leadInMs !== "auto") return Math.max(0, Math.round(config.leadInMs));
    return defaultSinkIsBluetooth() ? Math.max(0, Math.round(config.bluetoothLeadInMs)) : 0;
  }

  function cacheDir(): string {
    const base =
      process.env.XDG_CACHE_HOME && process.env.XDG_CACHE_HOME.length > 0
        ? process.env.XDG_CACHE_HOME
        : join(homedir(), ".cache");
    return join(base, "pi-sounds");
  }

  /** Cached copy of `source` with `leadIn` ms of real digital silence in front of it. */
  function paddedFile(source: string, leadIn: number): string {
    try {
      const stat = statSync(source);
      const target = join(
        cacheDir(),
        `${basename(source).replace(/\.[^.]+$/, "")}-${stat.size}-${Math.round(stat.mtimeMs)}-${leadIn}.wav`,
      );
      if (existsSync(target)) return target;
      mkdirSync(cacheDir(), { recursive: true });
      const temporary = `${target}.part-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-y",
          "-i",
          source,
          "-af",
          `adelay=${leadIn}:all=1`,
          "-c:a",
          "pcm_s16le",
          "-f",
          "wav",
          temporary,
        ],
        { timeout: 15_000, stdio: ["ignore", "ignore", "ignore"] },
      );
      renameSync(temporary, target);
      return target;
    } catch {
      // Padding is best-effort: play the original file rather than nothing.
      return source;
    }
  }

  // -- playback ------------------------------------------------------------

  function bell(): void {
    try {
      if (process.stdout.isTTY) process.stdout.write("\x07");
    } catch {
      // ignore
    }
  }

  function stopChildren(): void {
    for (const child of children) {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }
    children.clear();
  }

  function playSound(event: SoundEvent, rule: EventRule, ctx: ExtensionContext): void {
    const source = soundFor(event, rule);
    if (source === null) {
      if (rule.sound !== "bell") {
        notifyOnce(
          ctx,
          `missing:${rule.sound}`,
          `pi-sounds: no sound file "${rule.sound}" in ${config.soundsDir} — using the terminal bell`,
        );
      }
      bell();
      return;
    }

    const leadIn = leadInFor();
    const file = leadIn > 0 ? paddedFile(source, leadIn) : source;

    const player = playerFor(rule.player ?? config.player);
    if (!player || !player.def.command) {
      bell();
      return;
    }

    if (config.stopPrevious) stopChildren();

    const volume = Math.min(1, Math.max(0, rule.volume ?? config.volume));
    try {
      const child = spawn(player.def.command, renderArgs(player, file, volume), {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", (error: Error) => {
        children.delete(child);
        notifyOnce(
          ctx,
          `player:${player.name}`,
          `pi-sounds: ${player.name} failed (${error.message}) — using the terminal bell`,
        );
        bell();
      });
      child.on("exit", () => {
        children.delete(child);
      });
      child.unref();
      children.add(child);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notifyOnce(
        ctx,
        `spawn:${player.name}`,
        `pi-sounds: cannot start ${player.name} (${message})`,
      );
      bell();
    }
  }

  function fire(event: SoundEvent, ctx: ExtensionContext): void {
    if (!config.enabled || muted) return;
    const rule = config.events[event];
    if (!rule.enabled) return;
    const now = Date.now();
    if (now - (lastFired.get(event) ?? 0) < config.cooldownMs) return;
    lastFired.set(event, now);
    playSound(event, rule, ctx);
  }

  function fireQuestion(ctx: ExtensionContext): void {
    if (waiting) return;
    waiting = true;
    fire("question", ctx);
  }

  function playerLabel(): string {
    const player = playerFor(config.player);
    if (!player || !player.def.command) return "terminal bell";
    return player.name;
  }

  function leadInLabel(): string {
    const leadIn = leadInFor();
    if (leadIn <= 0) return "no lead-in";
    return config.leadInMs === "auto" ? `lead-in ${leadIn}ms (bluetooth)` : `lead-in ${leadIn}ms`;
  }

  // -- event bus -----------------------------------------------------------

  // The event bus delivers no context; reuse the last context we saw.
  let lastCtx: ExtensionContext | undefined;

  function subscribeToChannels(): void {
    for (const unsubscribe of busUnsubscribers) unsubscribe();
    busUnsubscribers = [];
    // The questionnaire announces the exact moment it starts waiting; the tool_call
    // hook below already covers the common case, so this is opt-in via the config.
    for (const channel of config.question.eventChannels) {
      busUnsubscribers.push(
        pi.events.on(channel, (data) => {
          if (!ready) return;
          const active = (data as { active?: unknown } | null)?.active;
          if (active === false) {
            waiting = false;
            return;
          }
          if (lastCtx) fireQuestion(lastCtx);
        }),
      );
    }
  }

  // -- lifecycle -----------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    const loaded = loadConfig(ctx);
    config = loaded.config;
    configPath = loaded.path;
    playerCache.clear();
    soundCache.clear();
    sinkProbe = undefined;
    stopChildren();
    lastFired.clear();
    let enabled = config.enabled;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
        const data = entry.data as { enabled?: unknown } | undefined;
        if (typeof data?.enabled === "boolean") enabled = data.enabled;
      }
    }
    if (pi.getFlag("no-sounds")) enabled = false;
    muted = !enabled;

    subscribeToChannels();
    ready = true;
  });

  pi.on("session_shutdown", async () => {
    ready = false;
    waiting = false;
    // Deliberately not killing spawned players: the sound should finish even when pi
    // exits immediately after settling (print mode, Ctrl+C right after a reply).
    children.clear();
    for (const unsubscribe of busUnsubscribers) unsubscribe();
    busUnsubscribers = [];
  });

  pi.on("agent_start", async (_event, ctx) => {
    lastCtx = ctx;
    outcome = undefined;
  });

  pi.on("agent_end", async (event) => {
    const last = [...event.messages].reverse().find((message) => message.role === "assistant") as
      | { stopReason?: string }
      | undefined;
    if (!last) return;
    const stopReason = last.stopReason;
    if (stopReason === "aborted") outcome = "aborted";
    else if (stopReason && config.errors.stopReasons.includes(stopReason)) outcome = "error";
    else outcome = "ok";
  });

  pi.on("agent_settled", async (_event, ctx) => {
    lastCtx = ctx;
    // No assistant message at all means the run was aborted before it produced one.
    const final = outcome ?? "aborted";
    outcome = undefined;
    fire(final === "error" ? "error" : final === "aborted" ? "aborted" : "done", ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!ready) return;
    lastCtx = ctx;
    if (!config.question.tools.includes(event.toolName)) return;
    fireQuestion(ctx);
  });

  pi.on("tool_execution_end", async (event) => {
    if (config.question.tools.includes(event.toolName)) waiting = false;
  });

  pi.on("ui_prompt_start", async (_event, ctx) => {
    if (!ready || !config.question.uiPrompts) return;
    lastCtx = ctx;
    fireQuestion(ctx);
  });

  pi.on("ui_prompt_end", async () => {
    waiting = false;
  });

  // -- commands ------------------------------------------------------------

  pi.registerFlag("no-sounds", {
    description: "Start with notification sounds disabled",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("sounds", {
    description: "Notification sounds: /sounds on | /sounds off",
    getArgumentCompletions: (prefix: string) =>
      ["on", "off"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "on" || arg === "off") {
        muted = arg === "off";
        pi.appendEntry(STATE_ENTRY, { enabled: arg === "on" });
        ctx.ui.notify(arg === "on" ? "Sounds on" : "Sounds off", "info");
        return;
      }
      const where = configPath ?? "built-in defaults";
      ctx.ui.notify(
        `Sounds ${muted ? "off" : "on"} · player ${playerLabel()} · ${leadInLabel()} · ${where} · /sounds on | /sounds off`,
        "info",
      );
    },
  });
}
