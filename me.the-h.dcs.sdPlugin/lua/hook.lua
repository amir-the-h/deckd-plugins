-- deckd cockpit hook for DCS World (part of the me.the-h.dcs deckd plugin).
--
-- Loaded from Saved Games/DCS/Scripts/Export.lua by one line the plugin adds there. It keeps every
-- LuaExport* function that was defined before it and calls it first, so other export scripts keep
-- working, and it never lets its own errors escape into DCS.
--
-- It knows nothing about any aircraft: the plugin tells it which cockpit arguments and indicators
-- to watch, and it streams their values over UDP on localhost and runs the clickable actions the
-- plugin sends back.
--
-- DCS -> plugin                          plugin -> DCS
--   H <unit|-> <protocol>  heartbeat       W <arg>,<arg>,...     watch these arguments
--   A <arg>=<v> ...        changed args    WT <id>,<id>,...      watch these indicators' text
--   T <key> <text>         indicator text  C <dev> <cmd> <val>   performClickableAction
--   F agl= ias= gs=        flight data     WT entries are numeric ids or name=marker: the indicator
--                          (- when hidden)  whose text contains `marker`, sent as T <name> ...
--   L <text>               log line        K <cmd> [val]         LoSetCommand (key command)
--   S <unit> <ok|error>    scan finished   R                     send everything again
--                                          S <cockpit dir>       scan an aircraft (no host Lua)
--                                          D                     dump indicators to Logs/

if deckd_cockpit then return end -- loaded twice: keep the first copy
deckd_cockpit = {}

local M = deckd_cockpit
local PROTOCOL = 1
-- lfs paths may or may not end in a separator; Windows accepts doubled ones.
local function dir(path) return (path:gsub("[\\/]*$", "")) .. "\\" end
local here = dir(lfs.writedir()) .. [[Scripts\deckd\]]

-- --------------------------------------------------------------------------- settings

local config = { host = "127.0.0.1", send_port = 7790, listen_port = 7791, rate = 30 }
do
  local ok, user = pcall(dofile, here .. "config.lua")
  if ok and type(user) == "table" then for k, v in pairs(user) do config[k] = v end end
end

local function log_line(text)
  if log and log.write then
    log.write("DECKD", log.INFO, text)
  else
    print("DECKD: " .. text)
  end
end

-- --------------------------------------------------------------------------- state

local socket_lib, udp
local watch_args, watch_texts = {}, {} -- watch_texts: { key, id, marker }
local last_args, last_texts = {}, {}
local unit = "-"
local next_tick, next_full, next_flight, next_resolve = 0, 0, 0, 0
local reported = false
local last_pos, last_pos_time -- for ground speed from our own position (never hidden by servers)

local function send(msg)
  if udp then udp:sendto(msg, config.host, config.send_port) end
end

local function split_numbers(s)
  local out = {}
  for n in string.gmatch(s or "", "[^,%s]+") do
    local v = tonumber(n)
    if v then out[#out + 1] = v end
  end
  return out
end

-- Values rounded to 3 decimals, as text, so tiny jitter doesn't count as a change.
local function fmt(v)
  if type(v) ~= "number" then return "0" end
  local s = string.format("%.3f", v):gsub("0+$", ""):gsub("%.$", "")
  if s == "-0" then s = "0" end
  return s
end

local function main_panel()
  if not GetDevice then return nil end
  local ok, dev = pcall(GetDevice, 0)
  if ok and dev then return dev end
  return nil
end

-- --------------------------------------------------------------------------- commands from the plugin

local function scan_aircraft(cockpit_dir)
  local ok, err = pcall(function()
    local scan = dofile(here .. "scan.lua")
    local result = scan.scan(cockpit_dir, lfs.currentdir())
    local name = unit ~= "-" and unit or "unknown"
    lfs.mkdir(here .. "catalog")
    local f = assert(io.open(here .. "catalog\\" .. name .. ".json", "w"))
    f:write(scan.json(result))
    f:close()
  end)
  send("S " .. unit .. " " .. (ok and "ok" or ("error " .. tostring(err))))
end

local function dump_indicators()
  if not list_indication then return end
  local f = io.open(dir(lfs.writedir()) .. [[Logs\deckd-indicators.txt]], "w")
  if not f then return end
  for id = 0, 40 do
    local ok, text = pcall(list_indication, id)
    if ok and text and text ~= "" then
      f:write("==================== indicator ", id, "\n", text, "\n")
    end
  end
  f:close()
  send("L indicators written to Logs/deckd-indicators.txt")
end

-- "7,ufc=UFC_mask" -> { {key="7", id=7}, {key="ufc", marker="UFC_mask"} }
local function parse_text_watch(s)
  local out = {}
  for item in string.gmatch(s or "", "[^,%s]+") do
    local name, marker = item:match("^([%w_]+)=(.+)$")
    if name then out[#out + 1] = { key = name, marker = marker }
    elseif tonumber(item) then out[#out + 1] = { key = item, id = tonumber(item) } end
  end
  return out
end

-- Finds the indicator whose text contains each watch's marker (ids differ between aircraft and
-- are only known at run time).
local function resolve_texts()
  if not list_indication then return end
  for _, w in ipairs(watch_texts) do
    if w.marker and not w.id then
      for id = 0, 40 do
        local ok, text = pcall(list_indication, id)
        if ok and text and text:find(w.marker, 1, true) then w.id = id break end
      end
    end
  end
end

local function handle(msg)
  local kind, rest = msg:match("^(%u+)%s*(.*)$")
  if kind == "W" then
    watch_args = split_numbers(rest)
    last_args = {}
  elseif kind == "WT" then
    watch_texts = parse_text_watch(rest)
    last_texts, next_resolve = {}, 0
  elseif kind == "C" then
    local dev, cmd, val = rest:match("^(%-?%d+)%s+(%-?%d+)%s+(%S+)")
    local device = dev and GetDevice and GetDevice(tonumber(dev))
    if device then device:performClickableAction(tonumber(cmd), tonumber(val) or 0) end
  elseif kind == "K" then
    local cmd, val = rest:match("^(%-?%d+)%s*(%S*)")
    if cmd and LoSetCommand then
      if val ~= "" then LoSetCommand(tonumber(cmd), tonumber(val)) else LoSetCommand(tonumber(cmd)) end
    end
  elseif kind == "R" then
    last_args, last_texts, next_full = {}, {}, 0
  elseif kind == "S" then
    scan_aircraft(rest)
  elseif kind == "D" then
    dump_indicators()
  end
end

local function receive()
  if not udp then return end
  for _ = 1, 64 do
    local data = udp:receive()
    if not data then return end
    local ok, err = pcall(handle, data)
    if not ok then send("L error: " .. tostring(err)) end
  end
end

-- --------------------------------------------------------------------------- sending state

local function report_capabilities()
  if reported then return end
  reported = true
  local panel = main_panel()
  local caps = string.format("caps GetDevice=%s get_argument_value=%s performClickableAction=%s list_indication=%s LoGetSelfData=%s",
    tostring(GetDevice ~= nil), tostring(panel ~= nil and panel.get_argument_value ~= nil),
    tostring(panel ~= nil and panel.performClickableAction ~= nil), tostring(list_indication ~= nil), tostring(LoGetSelfData ~= nil))
  log_line(caps)
  send("L " .. caps)
end

local function tick(now)
  local full = now >= next_full
  if full then next_full = now + 1 end

  local self = LoGetSelfData and LoGetSelfData()
  local name = self and self.Name or "-"
  if name ~= unit then
    unit = name
    last_args, last_texts, full, next_resolve, last_pos = {}, {}, true, 0, nil
    for _, w in ipairs(watch_texts) do if w.marker then w.id = nil end end
  end
  if full then send("H " .. unit .. " " .. PROTOCOL) end
  if unit == "-" then return end
  report_capabilities()

  local panel = main_panel()
  if panel and panel.get_argument_value then
    local parts, size = {}, 2
    for _, a in ipairs(watch_args) do
      local v = fmt(panel:get_argument_value(a))
      if full or last_args[a] ~= v then
        last_args[a] = v
        local item = a .. "=" .. v
        if size + #item + 1 > 1200 then
          send("A " .. table.concat(parts, " "))
          parts, size = {}, 2
        end
        parts[#parts + 1] = item
        size = size + #item + 1
      end
    end
    if #parts > 0 then send("A " .. table.concat(parts, " ")) end
  end

  if list_indication then
    if now >= next_resolve then
      next_resolve = now + 2
      resolve_texts()
    end
    for _, w in ipairs(watch_texts) do
      if w.id then
        local ok, text = pcall(list_indication, w.id)
        text = ok and text or ""
        if full or last_texts[w.key] ~= text then
          last_texts[w.key] = text
          send("T " .. w.key .. " " .. text:sub(1, 8000))
        end
      end
    end
  end

  -- Height above ground and airspeed, for telling the ground from the air. Servers can hide them.
  if now >= next_flight then
    next_flight = now + 0.25
    local function get(f)
      if not f then return "-" end
      local ok, v = pcall(f)
      return ok and type(v) == "number" and fmt(v) or "-"
    end
    local gs = "-"
    local pos = self and self.Position
    if pos and pos.x and pos.z then
      if last_pos and now > last_pos_time then
        local dx, dz = pos.x - last_pos.x, pos.z - last_pos.z
        gs = fmt(math.sqrt(dx * dx + dz * dz) / (now - last_pos_time))
      end
      last_pos, last_pos_time = { x = pos.x, z = pos.z }, now
    end
    send("F agl=" .. get(LoGetAltitudeAboveGroundLevel) .. " ias=" .. get(LoGetIndicatedAirSpeed) .. " gs=" .. gs)
  end
end

-- --------------------------------------------------------------------------- DCS callbacks (chained)

local function start()
  package.path = package.path .. ";" .. dir(lfs.currentdir()) .. [[LuaSocket\?.lua]]
  package.cpath = package.cpath .. ";" .. dir(lfs.currentdir()) .. [[LuaSocket\?.dll]]
  socket_lib = require("socket")
  udp = socket_lib.udp()
  udp:setsockname(config.host, config.listen_port)
  udp:settimeout(0)
  unit, next_tick, next_full, next_flight, next_resolve, reported = "-", 0, 0, 0, 0, false
  last_args, last_texts = {}, {}
  log_line("cockpit hook started, sending to " .. config.host .. ":" .. config.send_port)
end

local function stop()
  if udp then
    send("H - " .. PROTOCOL)
    udp:close()
    udp = nil
  end
end

local function after_frame()
  if not udp then return end
  local now = socket_lib.gettime()
  if now < next_tick then return end
  next_tick = now + 1 / config.rate
  tick(now)
end

local function chain(name, ours)
  local previous = _G[name]
  _G[name] = function(...)
    if previous then
      local ok, err = pcall(previous, ...)
      if not ok then log_line(name .. " (previous script): " .. tostring(err)) end
    end
    local ok, err = pcall(ours, ...)
    if not ok then log_line(name .. ": " .. tostring(err)) end
  end
end

chain("LuaExportStart", start)
chain("LuaExportStop", stop)
chain("LuaExportBeforeNextFrame", receive)
chain("LuaExportAfterNextFrame", after_frame)

M.handle, M.tick = handle, tick -- for tests
