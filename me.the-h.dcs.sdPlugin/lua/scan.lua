-- Reads an aircraft's own cockpit scripts (devices.lua, clickabledata.lua, mainpanel_init.lua) and
-- returns what they define: every clickable element and every gauge/lamp argument, as JSON.
--
-- The scripts are written for DCS's cockpit Lua state, which has engine globals we don't have, so
-- they run in a sandbox where any unknown global is a harmless stand-in ("stub"). Nothing in the
-- scripts is copied: they are evaluated on the user's machine and only the resulting numbers kept.
--
-- Command line:  lua scan.lua <Cockpit/Scripts folder> [DCS install folder]   (prints JSON)
-- As a module:   local scan = dofile("scan.lua"); local t = scan.scan(dir, root); scan.json(t)
--
-- Works on Lua 5.1 (DCS, LuaJIT) and 5.2+.

local M = {}

-- --------------------------------------------------------------------------- stubs

local stub_names = setmetatable({}, { __mode = "k" })
local stub_mt = {}

local function stub(name)
  local s = setmetatable({}, stub_mt)
  stub_names[s] = name
  return s
end

local function is_stub(v) return type(v) == "table" and getmetatable(v) == stub_mt end
local function num(v) if type(v) == "number" then return v end return 0 end

stub_mt.__index = function(t, k)
  local s = stub((stub_names[t] or "?") .. "." .. tostring(k))
  rawset(t, k, s)
  return s
end
stub_mt.__call = function(t) return stub((stub_names[t] or "?") .. "()") end
stub_mt.__concat = function(a, b)
  local function str(v) if is_stub(v) then return stub_names[v] or "" end return tostring(v) end
  return str(a) .. str(b)
end
stub_mt.__tostring = function(t) return stub_names[t] or "stub" end
stub_mt.__len = function() return 0 end
stub_mt.__unm = function() return 0 end
for _, op in ipairs({ "__add", "__sub", "__mul", "__div", "__mod", "__pow" }) do
  stub_mt[op] = function() return 0 end
end
stub_mt.__eq = function() return false end
stub_mt.__lt = function() return false end
stub_mt.__le = function() return false end

-- math/string functions with stubs coerced to 0, so arithmetic on unknown view settings works.
local function safe_lib(lib)
  local t = {}
  for k, f in pairs(lib) do
    if type(f) == "function" then
      t[k] = function(...)
        local a = { ... }
        for i = 1, select("#", ...) do if is_stub(a[i]) then a[i] = 0 end end
        return f(unpack and unpack(a, 1, select("#", ...)) or table.unpack(a, 1, select("#", ...)))
      end
    else
      t[k] = f
    end
  end
  return t
end

-- --------------------------------------------------------------------------- the sandbox

local unpack_ = unpack or table.unpack

local function load_in(path, env)
  if setfenv then
    local f, err = loadfile(path)
    if not f then return nil, err end
    setfenv(f, env)
    return f
  end
  return loadfile(path, "t", env)
end

local function exists(path)
  local f = io.open(path, "r")
  if f then f:close() return true end
  return false
end

local function norm(path)
  path = path:gsub("\\", "/"):gsub("//+", "/")
  -- fold "a/b/../" so ../../Views.lua style paths resolve
  local prev
  repeat prev = path; path = path:gsub("[^/]+/%.%./", "", 1) until path == prev
  return path
end

local function make_env(dir, root, result)
  local env = {}
  local gauges = result.gauges
  local file_stack = {}

  local function current_file() return file_stack[#file_stack] or "" end

  local function run(path)
    path = norm(path)
    if not exists(path) then
      result.missing[#result.missing + 1] = path
      return
    end
    local f, err = load_in(path, env)
    if not f then
      result.errors[#result.errors + 1] = tostring(err)
      return
    end
    file_stack[#file_stack + 1] = path:match("([^/]+)$")
    local ok, e = pcall(f)
    file_stack[#file_stack] = nil
    if not ok then result.errors[#result.errors + 1] = path:match("([^/]+)$") .. ": " .. tostring(e) end
  end

  local class_type = setmetatable({}, { __index = function(_, k) return k end })
  local gettext = { translate = function(s) return s end, dtranslate = function(_, s) return s end }

  local function new_gauge()
    local g = { source = current_file() }
    gauges[#gauges + 1] = g
    return g
  end

  env._G = env
  env._ = function(s) return s end
  env.class_type = class_type
  env.math = safe_lib(math)
  env.string = string
  env.table = table
  env.pairs, env.ipairs, env.next, env.type, env.select = pairs, ipairs, next, type, select
  env.tostring, env.tonumber, env.unpack = tostring, tonumber, unpack_
  env.setmetatable, env.getmetatable, env.rawget, env.rawset = setmetatable, getmetatable, rawget, rawset
  env.pcall, env.error, env.assert = pcall, error, assert
  env.print = function() end
  env.require = function(name)
    if name == "i_18n" then return gettext end
    return stub("require(" .. tostring(name) .. ")")
  end
  env.dofile = function(path)
    if type(path) ~= "string" then return end
    run(path)
  end
  env.loadfile = function() return function() end end
  env.LockOn_Options = setmetatable({
    script_path = dir,
    common_script_path = root and (root .. "Scripts/Aircrafts/_Common/Cockpit/") or (dir .. "__none__/"),
    common_script_path_v2 = root and (root .. "Scripts/Aircrafts/_Common/Cockpit/") or (dir .. "__none__/"),
  }, { __index = function(t, k) local s = stub("LockOn_Options." .. k); rawset(t, k, s); return s end })
  env.CreateGauge = function() return new_gauge() end
  env.CreateSimpleGauge = function(arg, controller)
    local g = new_gauge()
    g.arg_number, g.controller = arg, controller
    return g
  end
  env.get_aircraft_type = function() return result.unit or "" end
  env.get_option_value = function() return nil end

  setmetatable(env, { __index = function(t, k)
    local s = stub(k)
    rawset(t, k, s)
    return s
  end })
  return env, run
end

-- --------------------------------------------------------------------------- collecting

-- Copies an array that may have holes; n is the length to use (the element's class count).
local function arr(t, n, conv)
  if type(t) ~= "table" or is_stub(t) then return nil end
  local out = { n = n }
  for i = 1, n do
    local v = t[i]
    if conv then v = conv(v) end
    out[i] = v
  end
  return out
end

local function number_or_nil(v) if type(v) == "number" then return v end return nil end
local function bool_or_nil(v) if type(v) == "boolean" then return v end return nil end
local function lim(v)
  if type(v) ~= "table" or is_stub(v) then return nil end
  if type(v[1]) ~= "number" or type(v[2]) ~= "number" then return nil end
  return { v[1], v[2] }
end

local function string_of(v)
  if type(v) == "string" then return v end
  if type(v) == "number" then return tostring(v) end
  if is_stub(v) then return stub_names[v] end
  return nil
end

-- name -> number tables the scripts define (CautionLights and friends), for naming lamps.
local function constant_tables(env)
  local out = {}
  for name, t in pairs(env) do
    if type(name) == "string" and type(t) == "table" and not is_stub(t) and name ~= "_G" and name ~= "devices" then
      local count = 0
      for k, v in pairs(t) do
        if type(k) == "string" and type(v) == "number" then count = count + 1 end
      end
      if count >= 3 then out[#out + 1] = { name = name, t = t } end
    end
  end
  -- prefer tables that sound like lights
  table.sort(out, function(a, b)
    local la = a.name:lower():find("light") or a.name:lower():find("lamp") or a.name:lower():find("caution")
    local lb = b.name:lower():find("light") or b.name:lower():find("lamp") or b.name:lower():find("caution")
    if (la ~= nil) ~= (lb ~= nil) then return la ~= nil end
    return a.name < b.name
  end)
  return out
end

local function constant_name(tables, value, prefer)
  for _, entry in ipairs(tables) do
    if not prefer or entry.name:lower():find(prefer) then
      for k, v in pairs(entry.t) do
        if v == value then return k end
      end
    end
  end
  return nil
end

function M.scan(dir, root)
  dir = norm(dir:gsub("/*$", "") .. "/")
  if root then root = norm(root:gsub("/*$", "") .. "/") end
  local result = { gauges = {}, errors = {}, missing = {} }
  local env, run = make_env(dir, root, result)

  run(dir .. "devices.lua")
  run(dir .. "clickabledata.lua")
  run(dir .. "mainpanel_init.lua")

  local out = { version = 1, devices = {}, elements = {}, gauges = {}, errors = result.errors }

  local devices = rawget(env, "devices")
  local device_names = {}
  if type(devices) == "table" and not is_stub(devices) then
    for name, id in pairs(devices) do
      if type(id) == "number" then
        device_names[id] = name
        out.devices[#out.devices + 1] = { id = id, name = name }
      end
    end
    table.sort(out.devices, function(a, b) return a.id < b.id end)
  end

  local elements = rawget(env, "elements")
  if type(elements) == "table" and not is_stub(elements) then
    for id, el in pairs(elements) do
      if type(el) == "table" and not is_stub(el) and type(el.class) == "table" and not is_stub(el.class) then
        local n = 0
        for i = 1, 8 do if el.class[i] ~= nil then n = i end end
        local device = number_or_nil(el.device)
        if n > 0 and device then
          out.elements[#out.elements + 1] = {
            id = tostring(id),
            hint = string_of(el.hint),
            device = device,
            class = arr(el.class, n, string_of),
            action = arr(el.action, n, number_or_nil),
            stop_action = arr(el.stop_action, n, number_or_nil),
            stop_value = arr(el.stop_value, n, number_or_nil),
            arg = arr(el.arg, n, number_or_nil),
            arg_value = arr(el.arg_value, n, number_or_nil),
            arg_lim = arr(el.arg_lim, n, lim),
            gain = arr(el.gain, n, number_or_nil),
            relative = arr(el.relative, n, bool_or_nil),
            release = arr(el.use_release_message, n, bool_or_nil),
            cycle = bool_or_nil(el.cycle),
          }
        end
      end
    end
    table.sort(out.elements, function(a, b) return a.id < b.id end)
  end

  -- Gauges: name them by the global they were stored in, else by the light constant they show,
  -- else by their controller.
  local global_of = {}
  for name, v in pairs(env) do
    if type(v) == "table" and not is_stub(v) and type(name) == "string" then global_of[v] = name end
  end
  local tables = constant_tables(env)
  local seen = {}
  for _, g in ipairs(result.gauges) do
    local arg = number_or_nil(g.arg_number)
    if arg and not seen[arg] then
      seen[arg] = true
      local controller = is_stub(g.controller) and (stub_names[g.controller] or ""):gsub("^controllers%.", "") or nil
      local param = type(g.params) == "table" and not is_stub(g.params) and number_or_nil(g.params[1]) or nil
      local name = global_of[g]
      if not name and param then name = constant_name(tables, param) end
      out.gauges[#out.gauges + 1] = {
        arg = arg,
        name = name or controller,
        controller = controller,
        source = g.source,
        input = type(g.input) == "table" and not is_stub(g.input) and arr(g.input, #g.input, number_or_nil) or nil,
        output = type(g.output) == "table" and not is_stub(g.output) and arr(g.output, #g.output, number_or_nil) or nil,
      }
    end
  end
  table.sort(out.gauges, function(a, b) return a.arg < b.arg end)
  return out
end

-- --------------------------------------------------------------------------- JSON

local function encode(v, buf)
  local t = type(v)
  if t == "nil" then buf[#buf + 1] = "null"
  elseif t == "boolean" then buf[#buf + 1] = v and "true" or "false"
  elseif t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then buf[#buf + 1] = "null"
    elseif v == math.floor(v) and math.abs(v) < 1e15 then buf[#buf + 1] = string.format("%d", v)
    else buf[#buf + 1] = string.format("%.6g", v) end
  elseif t == "string" then
    buf[#buf + 1] = '"' .. v:gsub('[%c"\\]', function(c)
      local map = { ['"'] = '\\"', ["\\"] = "\\\\", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }
      return map[c] or string.format("\\u%04x", c:byte())
    end) .. '"'
  elseif t == "table" and not is_stub(v) then
    local n = v.n or #v
    if n > 0 or next(v) == nil or v.n then
      buf[#buf + 1] = "["
      for i = 1, n do
        if i > 1 then buf[#buf + 1] = "," end
        encode(v[i], buf)
      end
      buf[#buf + 1] = "]"
    else
      buf[#buf + 1] = "{"
      local keys = {}
      for k in pairs(v) do if type(k) == "string" then keys[#keys + 1] = k end end
      table.sort(keys)
      local first = true
      for _, k in ipairs(keys) do
        if v[k] ~= nil then
          if not first then buf[#buf + 1] = "," end
          first = false
          encode(k, buf)
          buf[#buf + 1] = ":"
          encode(v[k], buf)
        end
      end
      buf[#buf + 1] = "}"
    end
  else
    buf[#buf + 1] = "null"
  end
end

function M.json(v)
  local buf = {}
  encode(v, buf)
  return table.concat(buf)
end

-- --------------------------------------------------------------------------- command line

if arg and arg[0] and arg[0]:match("scan%.lua$") and arg[1] then
  io.write(M.json(M.scan(arg[1], arg[2])), "\n")
end

return M
