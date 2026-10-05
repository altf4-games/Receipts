import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/** The app deploys alone (Vercel uploads app/ only), so it carries a copy of these sources. The copy must never drift. */
const here = path.dirname(new URL(import.meta.url).pathname);
const src = path.join(here, "../src");
const copy = path.join(here, "../../app/lib/rankers");

describe("app/lib/rankers is an exact copy of rankers/src", () => {
  const files = fs.readdirSync(copy).filter((f) => f.endsWith(".ts"));
  test("same set of files (the simulation stays out of the app)", () => {
    expect([...files].sort()).toEqual(fs.readdirSync(src).filter((f) => f.endsWith(".ts") && f !== "coinflipSim.ts").sort());
  });
  for (const f of files) {
    test(`${f} matches (imports differ only by the .js suffix)`, () => {
      const a = fs.readFileSync(path.join(src, f), "utf8").replace(/from "\.\/([a-zA-Z]+)\.js"/g, 'from "./$1"');
      expect(fs.readFileSync(path.join(copy, f), "utf8")).toBe(a);
    });
  }
});
