/**
 * Where the dataset is, and how to change it.
 *
 * This is the only module that knows the Rust-side `Origin` vocabulary; the
 * rest of the app asks it for a sentence or a chip label. Two rules shape it:
 *
 *   * **The choice is stored by Rust, not by this page.** It is written to
 *     `<app config>/source.json` before the first line of JavaScript runs, so
 *     the root is already correct when the app starts — a `localStorage` copy
 *     would only exist after this module loaded, which is too late for the
 *     first `read_dataset`.
 *   * **An environment variable outranks a remembered choice.** `smoke:app` and
 *     any scripted run set `RPEAK_DATA_DIR`; if a stored choice silently won,
 *     those runs would test a different dataset than the one they were told to.
 *     The override is reported rather than hidden, because a preference that
 *     loses quietly is a lie by omission.
 *
 * In a plain browser there is no Rust side. Everything here returns `null` and
 * the UI says the location is the dev server's, which is true.
 */

import { IS_TAURI } from "./dataset";

/** The rule that produced the current root, as Rust serialises it. */
export type Origin = "env" | "chosen" | "besideExe" | "localAppData" | "repoDebug" | "none";

export interface DataSource {
  /** Absolute path on disk, as Rust prints it. */
  path: string;
  origin: Origin;
  /**
   * A remembered choice that is **not** the one in force: because the
   * environment variable beat it, or because the folder no longer exists.
   * Reported, not deleted: only the user can tell us which folder to use now,
   * and "the folder you picked is not what you are reading" is a different
   * message from "nothing has ever been chosen".
   */
  remembered: string | null;
  /** Files that should be in a dataset and are not. The app still starts. */
  warnings: string[];
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

let invokePromise: Promise<Invoke> | null = null;

function getInvoke(): Promise<Invoke> {
  if (!invokePromise) {
    invokePromise = import("@tauri-apps/api/core").then((m) => m.invoke as unknown as Invoke);
  }
  return invokePromise;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  const invoke = await getInvoke();
  return (await invoke(cmd, args)) as T;
}

/** Where the packaged app is looking, or `null` in a browser. */
export async function describeSource(): Promise<DataSource | null> {
  try {
    return await call<DataSource>("data_source");
  } catch {
    return null;
  }
}

/**
 * Adopt a folder by path, without a dialog.
 *
 * The native picker cannot be driven from a test, so this is the arm every
 * automated check exercises; `chooseSource` is the same operation with a person
 * supplying the string.
 */
export async function setSource(path: string): Promise<DataSource | null> {
  return call<DataSource>("set_data_root", { path });
}

/** Open the native folder picker. `null` means the browser, or that the user
 * cancelled. */
export async function chooseSource(): Promise<DataSource | null> {
  return call<DataSource | null>("choose_data_root").then((v) => v ?? null);
}

/** Forget the remembered choice and fall back to the automatic locations. */
export async function resetSource(): Promise<DataSource | null> {
  return call<DataSource>("reset_data_root");
}

/**
 * The origin in one word, for a chip.
 *
 * English sentence keys, like every other string in this app, so the dictionary
 * owns the translation and a missing entry falls back to something readable.
 */
export function originLabel(origin: Origin): string {
  switch (origin) {
    case "env":
      return "environment variable";
    case "chosen":
      return "chosen";
    case "besideExe":
      return "beside the app";
    case "localAppData":
      return "user data folder";
    case "repoDebug":
      return "repository (dev)";
    default:
      return "not found";
  }
}

/**
 * Why the choice on screen may not be the one in force.
 *
 * Returns `null` when there is nothing to explain. Both branches are things the
 * app knows and the user does not: an environment variable beating a preference
 * the user set in this very window, and a remembered folder that has gone.
 *
 * Which one it is comes from `origin`, not from guessing: if the env variable
 * is not what is in force, the remembered folder cannot be the one being read,
 * so it must be gone.
 */
export function sourceNotice(src: DataSource): string | null {
  if (!src.remembered) return null;
  return src.origin === "env"
    ? "RPEAK_DATA_DIR is set, so it overrides the folder you chose earlier."
    : "The folder you chose earlier is gone: {path}. Using the next location instead.";
}
