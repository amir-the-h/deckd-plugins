-- Test fixture: gauges and lamps the way a main panel script declares them.
dofile(LockOn_Options.script_path.."devices.lua")
shape_name = "TestJet"
local view = ViewSettings.Cockpit[1]
local angle = math.rad(view.vAngle)

Altimeter = CreateGauge()
Altimeter.arg_number = 50
Altimeter.input = {0, 1000}
Altimeter.output = {0, 1}
Altimeter.controller = controllers.Altimeter

Baro_0 = CreateSimpleGauge(51, controllers.Baro0)
dofile(LockOn_Options.script_path.."MainPanel/lamps.lua")
livery = find_custom_livery("TestJet", "default")
