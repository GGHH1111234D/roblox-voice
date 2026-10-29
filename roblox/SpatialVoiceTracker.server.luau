--!strict
--[[
	SpatialVoiceTracker.server.luau
	===============================
	Placement: ServerScriptService/SpatialVoiceTracker (Script)

	Streams every player's 3D position to the FastAPI backend so the browser-side
	Web Audio engine can place each WebRTC voice in 3D space.

	What it does:
	  1. Every 0.5s, reads each player's HumanoidRootPart position (X, Y, Z) and facing (yaw).
	  2. POSTs ONE batched JSON object to `/update_locations` via HttpService:PostAsync:
	       {
	         "12345678": { "x": 10.5, "y": 3.0, "z": -20.25, "yaw": 1.57, "username": "Alex" },
	         "87654321": { "x": 14.0, "y": 3.0, "z": -18.00, "yaw": 0.00, "username": "Sam"  }
	       }
	     Keys are Roblox UserIds (strings). x/y/z are in studs, in Roblox world space.
	  3. Tags each request with an `X-Job-Id` header so the backend can keep players from
	     different Roblox servers apart (two people at the same coordinates in two different
	     servers must NOT hear each other).
	  4. Shows each player their own UserId in a small HUD badge — that's the number they type
	     into the web page to bind their browser mic to their character.

	Coordinate note:
	  Roblox world space is right-handed, +Y up, and a default-oriented part looks toward -Z.
	  The Web Audio API uses the exact same convention (listener forward defaults to -Z,
	  up = +Y, right = +X), so the browser can use these numbers 1:1 — no axis flipping.

	Rate budget:
	  0.5s interval = 120 requests/min per server, well under Roblox's 500 HTTP requests/min.

	REQUIRED in Roblox Studio:
	  Game Settings -> Security -> "Allow HTTP Requests" = ON
]]

local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")

-- ============================================================================
-- CONFIGURATION
-- ============================================================================
-- Local testing in Studio can hit your PC directly:
local BACKEND_URL: string = "http://127.0.0.1:8000/update_locations"
-- Live servers need a public HTTPS URL (Cloudflare Tunnel / ngrok / Render), e.g.:
-- local BACKEND_URL: string = "https://your-service-name.onrender.com/update_locations"

local UPDATE_INTERVAL: number = 0.5 -- seconds between position batches
local SERVER_SECRET: string = ""    -- optional; must match ROBLOX_API_SECRET on the Python side

-- game.JobId is "" inside Studio playtests, so synthesize a stable per-session id there.
local JOB_ID: string = if game.JobId ~= "" then game.JobId else ("studio-" .. HttpService:GenerateGUID(false))

-- ============================================================================
-- IN-GAME VOICE ID BADGE (shows the player the UserId to type on the web page)
-- ============================================================================
local function createVoiceIdBadge(player: Player)
	local playerGui = player:WaitForChild("PlayerGui", 10) :: PlayerGui?
	if not playerGui then
		return
	end

	local existing = playerGui:FindFirstChild("VoiceIdGui")
	if existing then
		existing:Destroy()
	end

	local screenGui = Instance.new("ScreenGui")
	screenGui.Name = "VoiceIdGui"
	screenGui.ResetOnSpawn = false -- survive respawns
	screenGui.DisplayOrder = 100

	local badge = Instance.new("Frame")
	badge.Name = "Badge"
	badge.AnchorPoint = Vector2.new(0.5, 0)
	badge.Position = UDim2.new(0.5, 0, 0, 12)
	badge.Size = UDim2.fromOffset(240, 40)
	badge.BackgroundColor3 = Color3.fromRGB(15, 23, 42)
	badge.BorderSizePixel = 0
	badge.Parent = screenGui

	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, 10)
	corner.Parent = badge

	local stroke = Instance.new("UIStroke")
	stroke.Color = Color3.fromRGB(88, 101, 242)
	stroke.Thickness = 1.5
	stroke.Transparency = 0.2
	stroke.Parent = badge

	local label = Instance.new("TextLabel")
	label.Name = "IdLabel"
	label.Size = UDim2.fromScale(1, 1)
	label.BackgroundTransparency = 1
	label.Font = Enum.Font.GothamBold
	label.TextSize = 15
	label.TextColor3 = Color3.fromRGB(248, 250, 252)
	label.Text = string.format("🎙️ Voice ID: %d", player.UserId)
	label.Parent = badge

	screenGui.Parent = playerGui
end

Players.PlayerAdded:Connect(createVoiceIdBadge)
for _, p in ipairs(Players:GetPlayers()) do
	task.spawn(createVoiceIdBadge, p)
end

-- ============================================================================
-- POSITION SAMPLING
-- ============================================================================
type LocationEntry = { x: number, y: number, z: number, yaw: number, username: string }

-- Two decimals is plenty (1/100 stud) and keeps the JSON body small.
local function round2(n: number): number
	return math.round(n * 100) / 100
end

local function collectPlayerLocations(): { [string]: LocationEntry }
	local locations: { [string]: LocationEntry } = {}

	for _, player in ipairs(Players:GetPlayers()) do
		local character = player.Character
		if not character then
			continue
		end

		local rootPart = character:FindFirstChild("HumanoidRootPart") :: BasePart?
		local humanoid = character:FindFirstChildOfClass("Humanoid")
		-- Dead/despawned characters are omitted -> the browser fades their voice out.
		if not rootPart or not humanoid or humanoid.Health <= 0 then
			continue
		end

		local pos = rootPart.Position
		local look = rootPart.CFrame.LookVector

		-- Yaw = heading around the Y axis, 0 when facing -Z, +pi/2 when facing +X.
		-- The browser rebuilds the forward vector as (sin(yaw), 0, -cos(yaw)).
		-- NOTE: HumanoidRootPart faces the walking direction (or the camera in shift-lock /
		-- first person). The server cannot see the client camera, so this is the best
		-- server-only approximation of "where the player's ears point".
		local yaw = math.atan2(look.X, -look.Z)

		locations[tostring(player.UserId)] = {
			x = round2(pos.X),
			y = round2(pos.Y),
			z = round2(pos.Z),
			yaw = round2(yaw),
			username = player.DisplayName,
		}
	end

	return locations
end

-- ============================================================================
-- HTTP TRANSPORT
-- ============================================================================
local function encodeLocations(locations: { [string]: LocationEntry }): string
	-- GOTCHA: HttpService:JSONEncode({}) returns "[]" (an empty ARRAY), but the backend
	-- expects a JSON OBJECT. Send a literal "{}" when nobody has a live character.
	if next(locations) == nil then
		return "{}"
	end
	return HttpService:JSONEncode(locations)
end

local function buildHeaders(): { [string]: string }
	local headers: { [string]: string } = {
		["X-Job-Id"] = JOB_ID,
		-- Lets ngrok free tunnels skip their HTML interstitial page.
		["ngrok-skip-browser-warning"] = "true",
	}
	if SERVER_SECRET ~= "" then
		headers["X-Server-Secret"] = SERVER_SECRET
	end
	return headers
end

local function postLocations(jsonBody: string): (boolean, string?)
	local ok, err = pcall(function()
		HttpService:PostAsync(
			BACKEND_URL,
			jsonBody,
			Enum.HttpContentType.ApplicationJson,
			false, -- no gzip; payloads are tiny
			buildHeaders()
		)
	end)
	return ok, if ok then nil else tostring(err)
end

-- Live game servers cannot reach your PC's localhost — warn loudly instead of spamming errors.
if not RunService:IsStudio() and (string.find(BACKEND_URL, "127.0.0.1", 1, true) or string.find(BACKEND_URL, "localhost", 1, true)) then
	warn("[SpatialVoiceTracker] BACKEND_URL points at localhost on a LIVE server. Set your public HTTPS tunnel URL!")
end

-- ============================================================================
-- MAIN LOOP (every 0.5s)
-- ============================================================================
local isSending = false -- never stack requests if the backend is slow
local isShuttingDown = false
local consecutiveFailures = 0

task.spawn(function()
	print(string.format("[SpatialVoiceTracker] Streaming positions every %.1fs -> %s (JobId %s)", UPDATE_INTERVAL, BACKEND_URL, JOB_ID))

	while not isShuttingDown do
		task.wait(UPDATE_INTERVAL)
		if isSending then
			continue -- previous request still in flight; skip this tick rather than queueing
		end

		local jsonBody = encodeLocations(collectPlayerLocations())

		isSending = true
		task.spawn(function()
			local ok, err = postLocations(jsonBody)
			if ok then
				if consecutiveFailures > 0 then
					print("[SpatialVoiceTracker] Backend reachable again.")
				end
				consecutiveFailures = 0
			else
				consecutiveFailures += 1
				-- Log the first failure, then only every 20th (~10s) to avoid output spam.
				if consecutiveFailures == 1 or consecutiveFailures % 20 == 0 then
					warn(string.format("[SpatialVoiceTracker] POST failed (%d in a row): %s", consecutiveFailures, err or "?"))
				end
			end
			isSending = false
		end)
	end
end)

-- On shutdown, send an empty batch so the backend drops this server's players instantly
-- (it would also expire them on its own after a few seconds without updates).
game:BindToClose(function()
	isShuttingDown = true
	postLocations("{}")
end)
