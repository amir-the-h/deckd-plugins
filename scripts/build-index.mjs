#!/usr/bin/env node
// Writes <out>/index.json, the plugin index deckd reads from a plugin source, for packages
// already built in <out> (by pack.sh). Package URLs are relative, so the index works wherever
// it's hosted next to them, e.g. as GitHub release assets.
//
// Usage: build-index.mjs <out> <source name> <homepage> <plugin.sdPlugin>...

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const [out, name, homepage, ...dirs] = process.argv.slice(2);
if (!out || !dirs.length) {
  console.error("usage: build-index.mjs <out> <source name> <homepage> <plugin.sdPlugin>...");
  process.exit(1);
}

/** The plugin's icon as a data URI, so the index needs no extra files. */
function icon(dir, path) {
  for (const [ext, type] of [[".svg", "image/svg+xml"], ["@2x.png", "image/png"], [".png", "image/png"]]) {
    const file = join(dir, path + ext);
    if (existsSync(file)) return `data:${type};base64,${readFileSync(file).toString("base64")}`;
  }
  return undefined;
}

const plugins = dirs.map((dir) => {
  dir = dir.replace(/\/+$/, "");
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const uuid = m.UUID || basename(dir).replace(/\.sdPlugin$/, "");
  const pkg = `${basename(dir).replace(/\.sdPlugin$/, "")}.streamDeckPlugin`;
  const sha256 = createHash("sha256").update(readFileSync(join(out, pkg))).digest("hex");
  return { uuid, name: m.Name, version: m.Version, author: m.Author, description: m.Description, icon: m.Icon && icon(dir, m.Icon), url: pkg, sha256 };
});

writeFileSync(join(out, "index.json"), JSON.stringify({ name, homepage, plugins }, null, 2) + "\n");
console.log(join(out, "index.json"));
