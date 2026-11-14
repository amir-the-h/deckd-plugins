const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const inst = require("../lib/install.js");
const { LUA_DIR } = require("./helpers.js");

function savedGames() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-sg-"));
  return { dir, exportPath: path.join(dir, "Scripts/Export.lua"), read: () => fs.readFileSync(path.join(dir, "Scripts/Export.lua"), "utf8") };
}

test("creates Export.lua when there is none, and removes it again", () => {
  const sg = savedGames();
  assert.equal(inst.status(sg.dir, LUA_DIR), "missing");
  assert.equal(inst.install(sg.dir, LUA_DIR), "created Export.lua");
  assert.equal(sg.read(), inst.LOAD_LINE + "\n");
  assert.ok(fs.existsSync(path.join(sg.dir, "Scripts/deckd/hook.lua")));
  assert.match(fs.readFileSync(path.join(sg.dir, "Scripts/deckd/config.lua"), "utf8"), /send_port = 7790, listen_port = 7791/);
  assert.equal(inst.status(sg.dir, LUA_DIR), "installed");
  inst.uninstall(sg.dir);
  assert.equal(fs.existsSync(sg.exportPath), false);
  assert.equal(fs.existsSync(path.join(sg.dir, "Scripts/deckd")), false);
  assert.equal(inst.status(sg.dir, LUA_DIR), "missing");
});

test("chains an existing Export.lua: appends one line, backs it up, removes only that line", () => {
  const sg = savedGames();
  fs.mkdirSync(path.dirname(sg.exportPath), { recursive: true });
  const original = "-- someone else's exporter\r\ndofile(lfs.writedir()..[[Scripts\\Other\\Export.lua]])";
  fs.writeFileSync(sg.exportPath, original);
  assert.match(inst.install(sg.dir, LUA_DIR), /backup/);
  assert.equal(sg.read(), `${original}\r\n${inst.LOAD_LINE}\r\n`, "keeps the file's line endings");
  assert.equal(fs.readFileSync(sg.exportPath + ".before-deckd", "utf8"), original);
  inst.install(sg.dir, LUA_DIR);
  assert.equal(sg.read().split(inst.MARKER).length, 2, "installing again doesn't add a second line");
  inst.uninstall(sg.dir);
  assert.equal(sg.read(), `${original}\r\n`);
});

test("reports a hook that needs repair", () => {
  const sg = savedGames();
  inst.install(sg.dir, LUA_DIR);
  fs.writeFileSync(path.join(sg.dir, "Scripts/deckd/hook.lua"), "-- old version");
  assert.equal(inst.status(sg.dir, LUA_DIR), "outdated");
  inst.install(sg.dir, LUA_DIR);
  assert.equal(inst.status(sg.dir, LUA_DIR), "installed");
  fs.writeFileSync(sg.exportPath, "-- user removed our line\n");
  assert.equal(inst.status(sg.dir, LUA_DIR), "unlinked");
});

test("writes the ports the plugin uses", () => {
  assert.match(inst.configLua({ sendPort: 9000, listenPort: 9001, rate: 20 }), /send_port = 9000, listen_port = 9001, rate = 20/);
});

test("finds DCS and its Proton Saved Games in any Steam library", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-home-"));
  const lib = path.join(home, "nvme/SteamLibrary");
  const other = path.join(home, "hdd/SteamLibrary");
  const steam = path.join(home, ".local/share/Steam");
  fs.mkdirSync(path.join(steam, "steamapps"), { recursive: true });
  fs.mkdirSync(path.join(lib, "steamapps/common/DCSWorld/Mods"), { recursive: true });
  fs.mkdirSync(path.join(lib, "steamapps/compatdata/223750/pfx/drive_c/users/steamuser/Saved Games/DCS"), { recursive: true });
  fs.mkdirSync(path.join(other, "steamapps"), { recursive: true });
  fs.writeFileSync(path.join(steam, "steamapps/libraryfolders.vdf"),
    `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${steam}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${other}"\n\t}\n\t"2"\n\t{\n\t\t"path"\t\t"${lib}"\n\t\t"apps"\n\t\t{\n\t\t\t"223750"\t\t"1"\n\t\t}\n\t}\n}\n`);
  const found = inst.locate({}, home);
  assert.equal(found.root, path.join(lib, "steamapps/common/DCSWorld"));
  assert.equal(found.savedGames, path.join(lib, "steamapps/compatdata/223750/pfx/drive_c/users/steamuser/Saved Games/DCS"));
  assert.deepEqual(inst.locate({ dcsRoot: "/nowhere" }, home).root, found.root, "a path that has gone is looked up again");

  // Mid-move: both libraries have a copy; the one with Steam's app manifest wins.
  fs.mkdirSync(path.join(other, "steamapps/common/DCSWorld/Mods"), { recursive: true });
  fs.mkdirSync(path.join(other, "steamapps/compatdata/223750/pfx/drive_c/users/steamuser/Saved Games/DCS"), { recursive: true });
  fs.writeFileSync(path.join(lib, "steamapps/appmanifest_223750.acf"), "");
  assert.equal(inst.locate({}, home).root, found.root);
  fs.rmSync(path.join(lib, "steamapps/appmanifest_223750.acf"));
  fs.writeFileSync(path.join(other, "steamapps/appmanifest_223750.acf"), "");
  assert.equal(inst.locate({}, home).root, path.join(other, "steamapps/common/DCSWorld"));
  assert.match(inst.locate({}, home).savedGames, /hdd/);
  fs.rmSync(home, { recursive: true });
});
