-- Test fixture: lamps, some named by a constants table, some by their global.
local count = -1
local function counter() count = count + 1 return count end
WarningLights = { LT_MASTER_CAUTION = counter(), LT_FIRE = counter(), LT_GEAR = counter() }
function lamp(arg, controller, param)
  local g = CreateGauge()
  g.arg_number = arg
  g.input = {-1, 1}
  g.output = {-1, 1}
  g.controller = controller
  if param ~= nil then g.params = {param} end
  return g
end
lamp(60, controllers.WarnLights, WarningLights.LT_MASTER_CAUTION)
lamp(61, controllers.WarnLights, WarningLights.LT_FIRE)
lamp(62, controllers.WarnLights, WarningLights.LT_GEAR)
Console_lt = lamp(70, controllers.ConsoleLights)
