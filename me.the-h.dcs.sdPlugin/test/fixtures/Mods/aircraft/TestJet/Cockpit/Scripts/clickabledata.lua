-- Test fixture: a small cockpit using the constructors above.
dofile(LockOn_Options.script_path.."clickable_defs.lua")
dofile(LockOn_Options.script_path.."command_defs.lua")
dofile(LockOn_Options.script_path.."devices.lua")
dofile(LockOn_Options.common_script_path.."not_there.lua")
local gettext = require("i_18n")
_ = gettext.translate

elements = {}
elements["pnt_1"] = make_toggle(_("Battery Switch, ON/OFF"), devices.ELECTRIC, elec_commands.Battery, 1)
elements["pnt_2"] = make_three_way(_("Generator Switch, ON/OFF/TEST"), devices.ELECTRIC, elec_commands.Generator, 2)
elements["pnt_3"] = make_button(_("Start Button - Push to start"), devices.ELECTRIC, elec_commands.StartButton, 3)
elements["pnt_10"] = make_toggle(_("Master Arm Switch, ARM/SAFE"), devices.WEAPONS, weapon_commands.Arm, 10)
elements["pnt_11"] = make_rotary(_("Mode Knob, OFF/ONE/TWO/THREE"), devices.WEAPONS, weapon_commands.Mode, 11, 4, 0.1)
elements["pnt_20"] = { class = {class_type.TUMB, class_type.TUMB, class_type.LEV}, hint = _("Gear Handle, (RMB)UP/(LMB)DOWN"),
  device = devices.GEAR, action = {gear_commands.LeverUp, gear_commands.LeverDown, gear_commands.Emergency},
  arg = {20, 20, 21}, arg_value = {-1, 1, 1}, arg_lim = {{0, 1}, {0, 1}, {0, 1}}, gain = {1, 1, -1}, relative = {false, false, true} }
elements["pnt_30"] = make_axis(_("Radio Volume Knob"), devices.RADIO, radio_commands.Volume, 30, 0.1)
elements["pnt_31"] = { class = {class_type.BTN, class_type.LEV}, hint = _("Radio Channel Knob"), device = devices.RADIO,
  action = {radio_commands.ChannelPull, radio_commands.Channel}, stop_action = {radio_commands.ChannelPull, 0},
  arg = {31, 32}, arg_value = {1, 1}, arg_lim = {{0, 1}, {0, 1}}, gain = {1, 0.2}, relative = {false, true}, use_release_message = {true, false} }
elements["pnt_40"] = make_spring(_("Canopy Switch, OPEN/HOLD/CLOSE"), devices.GEAR, gear_commands.LeverUp, gear_commands.LeverUp, 40)
elements["pnt_40"].sound = {{SOUND_CLICK}}
