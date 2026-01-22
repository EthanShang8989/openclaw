import { describe, expect, it } from "vitest";

import { parseJsonOutput } from "./zca.js";

describe("parseJsonOutput", () => {
  it("parses plain JSON output", () => {
    expect(parseJsonOutput<{ ok: boolean }>('{"ok":true}')).toEqual({ ok: true });
  });

  it("parses JSON wrapped in ANSI codes", () => {
    const output = "\u001B[32m{\"ok\":true}\u001B[0m";
    expect(parseJsonOutput<{ ok: boolean }>(output)).toEqual({ ok: true });
  });

  it("parses JSON after log prefix lines", () => {
    const output = ["INFO starting up", "{\"items\":[1,2]}"].join("\n");
    expect(parseJsonOutput<{ items: number[] }>(output)).toEqual({ items: [1, 2] });
  });

  it("skips invalid JSON blocks and returns the next payload", () => {
    const output = ["INFO", "{bad}", "{\"ok\":true}"].join("\n");
    expect(parseJsonOutput<{ ok: boolean }>(output)).toEqual({ ok: true });
  });

  it("returns null when no JSON payload is found", () => {
    expect(parseJsonOutput("INFO no payload")).toBeNull();
  });
});
