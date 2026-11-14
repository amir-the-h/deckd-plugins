-- Test fixture: command numbers start at 3000 per device.
local function block(names)
  local t, n = {}, 3000
  for _, name in ipairs(names) do n = n + 1; t[name] = n end
  return t
end
elec_commands = block({ "Battery", "Generator", "StartButton" })
weapon_commands = block({ "Arm", "Mode", "Release" })
gear_commands = block({ "LeverUp", "LeverDown", "Emergency" })
radio_commands = block({ "Volume", "Channel", "ChannelPull" })
