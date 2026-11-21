// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A server component must not use a plain function or constant exported by a `"use client"` module.
 *
 * On the server such an import is only a reference to client code. Rendering a client *component*
 * through it is fine, but calling a function or reading a value fails, and only when that line
 * actually runs: the door scanner page rendered until the first check-in gave it an address to
 * shorten, then failed for every later scan. Unit tests can't see this (jsdom has no server and
 * client split) and neither does the type checker, so this test reads the imports instead.
 *
 * To fix a failure, move the helper into a module without `"use client"` and import it from there.
 */

const SRC = resolve("src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "generated" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const sources = new Map(sourceFiles(SRC).map((file) => [file, readFileSync(file, "utf8")]));

/** The directive must come first, before any code; comments above it are allowed. */
function isClientModule(file: string): boolean {
  return /^(\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*["']use client["']/.test(sources.get(file) ?? "");
}

function resolveImport(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? join(SRC, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(from), specifier)
      : null;
  if (!base) return null;
  return [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")].find((path) => sources.has(path)) ?? null;
}

/** Named imports that are not types and not components (components start with a capital letter). */
function plainValueImports(clause: string): string[] {
  const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? "";
  return named
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "" && !name.startsWith("type "))
    .map((name) => name.split(/\s+as\s+/)[0] as string)
    .filter((name) => !/^[A-Z][a-z]/.test(name));
}

function violations(): string[] {
  const found: string[] = [];
  for (const [file, source] of sources) {
    if (isClientModule(file)) continue;
    for (const match of source.matchAll(/import\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/g)) {
      const [, typeOnly, clause = "", specifier = ""] = match;
      if (typeOnly) continue;
      const target = resolveImport(file, specifier);
      if (!target || !isClientModule(target)) continue;
      const values = plainValueImports(clause);
      if (values.length > 0) {
        found.push(`${relative(".", file)} uses ${values.join(", ")} from the client module ${relative(".", target)}`);
      }
    }
  }
  return found.map((line) => line.replaceAll("\\", "/")).sort();
}

describe("server and client modules", () => {
  it("finds the client modules and the code that imports them", () => {
    // Guards the guard: if the scan stopped seeing files, the next test would pass for no reason.
    const clients = [...sources.keys()].filter(isClientModule);
    expect(clients.length).toBeGreaterThan(10);
    expect(clients.map((file) => relative(".", file).replaceAll("\\", "/"))).toContain("src/features/checkin/gate-scanner.tsx");
    expect(plainValueImports("{ GateScanner, shortAddress, type State, FAILURE_COPY as copy }")).toEqual([
      "shortAddress",
      "FAILURE_COPY",
    ]);
  });

  it("no server module uses a plain function or constant from a client module", () => {
    expect(violations()).toEqual([]);
  });
});
