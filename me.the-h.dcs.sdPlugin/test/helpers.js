// Shared test helpers: a Lua interpreter if this machine has one, and the fixture paths.
const path = require("node:path");
const { findLua } = require("../lib/catalog.js");

const FIXTURES = path.join(__dirname, "fixtures");
const JET = path.join(FIXTURES, "Mods/aircraft/TestJet/Cockpit/Scripts");
const LUA_DIR = path.join(__dirname, "..", "lua");
const lua = findLua();
const needLua = lua ? {} : { skip: "no Lua interpreter on this machine" };

module.exports = { FIXTURES, JET, LUA_DIR, lua, needLua };
