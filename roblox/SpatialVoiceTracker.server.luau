--!strict
--[[
	SpatialVoiceTracker.server.luau
	===============================
	Place this Script inside `ServerScriptService` in Roblox Studio.

	IMPORTANT ROBLOX STUDIO SETUP:
	1. Open Home / File -> Game Settings -> Security
	2. Enable "Allow HTTP Requests" = ON
	3. Set `BACKEND_URL` below to:
	   - Local Studio testing: "http://127.0.0.1:8000/update_locations"
	   - Live Roblox servers:  "https://your-service-name.onrender.com/update_locations"
]]

local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")

-- ============================================================================
-- Configuration
-- ============================================================================
local BACKEND_URL: string = "http://127.0.0.1:8000/update_locations"
local UPDATE_INTERVAL: number = 0.5 -- Seconds between position updates (120 req/min, well under Roblox's 500/min limit)
local SERVER_SECRET: string = ""    -- Optional: Match `ROBLOX_API_SECRET` env var on Render for endpoint security

-- ============================================================================
-- Helpers
-- ============================================================================
local function round2(n: number): number
	return math.round(n * 100) / 100
end

local function collectPlayerLocations(): { [string]: { x: number, y: number, z: number, yaw: number } }
	local locations: { [string]: { x: number, y: number, z: number, yaw: number } } = {}

	for _, player in ipairs(Players:GetPlayers()) do
		local character = player.Character
		if not character then
			continue
		end

		local rootPart = character:FindFirstChild("HumanoidRootPart") :: BasePart?
		local humanoid = character:FindFirstChildOfClass("Humanoid")

		-- Only track spawned, living characters with a valid HumanoidRootPart
		if rootPart and humanoid and humanoid.Health > 0 then
			local pos = rootPart.Position
			local look = rootPart.CFrame.LookVector

			-- Horizontal heading angle around Y axis (0 = facing -Z, +pi/2 = facing +X).
			-- Allows the browser's PannerNode to rotate left/right audio as the player turns!
			local yaw = math.atan2(look.X, -look.Z)

			-- CRITICAL ROBLOX GOTCHA:
			-- Always use `tostring(player.UserId)` as the table key! Numeric UserId keys
			-- create sparse Lua arrays that cause `HttpService:JSONEncode` to throw an error.
			locations[tostring(player.UserId)] = {
				x = round2(pos.X),
				y = round2(pos.Y),
				z = round2(pos.Z),
				yaw = round2(yaw),
			}
		end
	end

	return locations
end

-- ============================================================================
-- Continuous 0.5s Sync Loop
-- ============================================================================
local isRequestInFlight = false

task.spawn(function()
	print("[SpatialVoiceTracker] Started 3D position sync ->", BACKEND_URL)

	while true do
		task.wait(UPDATE_INTERVAL)

		-- Guard against overlapping HTTP calls if the backend is waking up on Render
		if isRequestInFlight then
			continue
		end

		local locationsPayload = collectPlayerLocations()
		local jsonBody = HttpService:JSONEncode(locationsPayload)

		local headers: { [string]: string } = {}
		if SERVER_SECRET ~= "" then
			headers["X-Server-Secret"] = SERVER_SECRET
		end

		isRequestInFlight = true
		task.spawn(function()
			local success, err = pcall(function()
				HttpService:PostAsync(
					BACKEND_URL,
					jsonBody,
					Enum.HttpContentType.ApplicationJson,
					false,
					headers
				)
			end)

			if not success then
				warn("[SpatialVoiceTracker] Failed posting locations:", err)
			end

			isRequestInFlight = false
		end)
	end
end)
