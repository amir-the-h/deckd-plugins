-- Runs lua/hook.lua outside DCS with fake DCS, lfs and LuaSocket APIs, printing what it does.
-- Used by hook.test.js:  lua hook_driver.lua <hook.lua> <temp dir>

local hook_path, tmp = arg[1], arg[2]
local function emit(s) io.write(s, "\n") end

local now = 100
local inbox = {}
package.loaded.socket = {
  gettime = function() return now end,
  udp = function()
    return {
      setsockname = function(_, host, port) emit("BIND " .. host .. " " .. port) return 1 end,
      settimeout = function() end,
      sendto = function(_, msg, host, port) emit("SEND " .. port .. " " .. msg) end,
      receive = function() return table.remove(inbox, 1) end,
      close = function() emit("CLOSE") end,
    }
  end,
}
lfs = { writedir = function() return tmp .. "/" end, currentdir = function() return tmp end, mkdir = function() end }
log = { INFO = 1, ERROR = 2, write = function(_, _, s) emit("LOG " .. s) end }

local values = { [49] = 1, [50] = 0.5 }
GetDevice = function(id)
  return {
    get_argument_value = function(_, a) return values[a] or 0 end,
    performClickableAction = function(_, c, v) emit(string.format("CLICK %d %d %s", id, c, tostring(v))) end,
  }
end
local unit = nil
local ufc = "\n-----------------------------------------\nUFC_mask\n\n-----------------------------------------\nUFC_Comm1Display\n 7\n"
list_indication = function(id) if id == 3 then return ufc end return "" end
LoGetAltitudeAboveGroundLevel = function() return 0.5 end -- LoGetIndicatedAirSpeed left out: a server hiding it
local x = 0
LoGetSelfData = function() return unit and { Name = unit, Position = { x = x, y = 10, z = 0 } } or nil end

-- An export script that was there before ours.
function LuaExportStart() emit("PREV start") end
function LuaExportAfterNextFrame() emit("PREV after") end

local function step(label) emit("-- " .. label) end

dofile(hook_path)
dofile(hook_path) -- loading twice must not chain twice

step("start")
LuaExportStart()
step("no aircraft")
LuaExportAfterNextFrame()

step("in aircraft")
unit = "TestJet"
inbox = { "W 49,50", "WT ufc=UFC_mask", "C 23 3003 1", "garbage" }
now = now + 0.1
LuaExportBeforeNextFrame()
LuaExportAfterNextFrame()

step("unchanged")
now = now + 0.1
LuaExportAfterNextFrame()

step("changed")
values[49] = 0
now = now + 0.1
LuaExportAfterNextFrame()

step("text changed")
ufc = ufc:gsub(" 7", " 8")
x = 3 -- moved 3 m in 0.3 s since the last flight report
now = now + 0.1
LuaExportAfterNextFrame()

step("too soon")
values[49] = 1
now = now + 0.001
LuaExportAfterNextFrame()

step("stop")
LuaExportStop()
