-- Test fixture written for the deckd DCS plugin's tests: shaped like an aircraft mod's entry.lua.
declare_plugin("Test Jet", {})
make_flyable('TestJet', current_mod_path..'/Cockpit/Scripts/', {"Test Jet"}, current_mod_path..'/comm.lua')
plugin_done()
