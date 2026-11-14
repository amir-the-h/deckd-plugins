-- Test fixture: element constructors in the same table shape the cockpit engine reads.
function make_button(hint, device, command, arg)
  return { class = {class_type.BTN}, hint = hint, device = device, action = {command}, stop_action = {command},
           arg = {arg}, arg_value = {1}, arg_lim = {{0, 1}}, use_release_message = {true} }
end
function make_toggle(hint, device, command, arg)
  return { class = {class_type.TUMB, class_type.TUMB}, hint = hint, device = device, action = {command, command},
           arg = {arg, arg}, arg_value = {-1, 1}, arg_lim = {{0, 1}, {0, 1}} }
end
function make_three_way(hint, device, command, arg)
  return { class = {class_type.TUMB, class_type.TUMB}, hint = hint, device = device, action = {command, command},
           arg = {arg, arg}, arg_value = {-1, 1}, arg_lim = {{-1, 1}, {-1, 1}} }
end
function make_rotary(hint, device, command, arg, count, step)
  return { class = {class_type.TUMB, class_type.TUMB}, hint = hint, device = device, action = {command, command},
           arg = {arg, arg}, arg_value = {-step, step}, arg_lim = {{0, step * (count - 1)}, {0, step * (count - 1)}}, cycle = false }
end
function make_spring(hint, device, cmd_a, cmd_b, arg)
  return { class = {class_type.BTN, class_type.BTN}, hint = hint, device = device, action = {cmd_a, cmd_b},
           stop_action = {cmd_a, cmd_b}, arg = {arg, arg}, arg_value = {-1, 1}, arg_lim = {{-1, 0}, {0, 1}},
           use_release_message = {true, true} }
end
function make_axis(hint, device, command, arg, gain, relative)
  return { class = {class_type.LEV}, hint = hint, device = device, action = {command}, arg = {arg},
           arg_value = {0.05}, arg_lim = {{0, 1}}, gain = {gain}, relative = {relative or false} }
end
