-- Test fixture: device ids from a counter, as cockpit scripts number them.
local count = 0
local function counter() count = count + 1 return count end
devices = {}
devices["ELECTRIC"] = counter() -- 1
devices["WEAPONS"] = counter()  -- 2
devices["GEAR"] = counter()     -- 3
devices["RADIO"] = counter()    -- 4
