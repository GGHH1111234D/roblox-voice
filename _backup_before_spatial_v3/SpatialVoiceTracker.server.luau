--!strict
--[[
	SpatialVoiceTracker.server.luau
	===============================
	نظام تتبع الصوت المكاني ثلاثي الأبعاد والربط برمز PIN فقط (بدون ديسكورد نهائياً).
	مكان السكربت: ServerScriptService في Roblox Studio.

	المميزات:
	1. توليد رمز PIN عشوائي من 4 أرقام لكل لاعب يدخل اللعبة تلقائياً.
	2. عرض شارة PIN صغيرة وأنيقة في أعلى شاشة اللاعب + رسالة في الشات.
	3. إرسال إحداثيات اللاعبين (X, Y, Z, Yaw) مع رمز الـ PIN كل 0.5 ثانية إلى سيرفر الويب.
	4. لا يتطلب ديسكورد ولا حسابات ولا بوتات - اللاعب يكتب الـ PIN في المتصفح فقط!

	تنبيه هام في Roblox Studio:
	Game Settings -> Security -> تفعيل "Allow HTTP Requests" = ON
]]

local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")

-- ============================================================================
-- الإعدادات (Configuration)
-- ============================================================================
-- استخدم الرابط المحلي أثناء التجربة في Studio:
local BACKEND_URL: string = "http://127.0.0.1:8000/update_locations"
-- أو عند النشر على Render استخدم رابط السيرفر الخاص بك:
-- local BACKEND_URL: string = "https://your-service-name.onrender.com/update_locations"

local UPDATE_INTERVAL: number = 0.5 -- إرسال الإحداثيات مرتين بالثانية
local SERVER_SECRET: string = ""    -- اختياري: إذا وضعت ROBLOX_API_SECRET في سيرفر البايثون

-- ============================================================================
-- إدارة رموز الـ PIN (PIN Generation)
-- ============================================================================
local playerPins: { [number]: string } = {}
local usedPins: { [string]: boolean } = {}

local function generateUniquePin(player: Player): string
	local rng = Random.new()
	local pin: string
	repeat
		pin = string.format("%04d", rng:NextInteger(1000, 9999))
	until not usedPins[pin]

	usedPins[pin] = true
	playerPins[player.UserId] = pin
	player:SetAttribute("VoicePIN", pin)
	return pin
end

-- ============================================================================
-- واجهة عرض الـ PIN في شاشة اللاعب (In-Game PIN HUD)
-- ============================================================================
local function createPinGui(player: Player, pin: string)
	local playerGui = player:WaitForChild("PlayerGui", 10) :: PlayerGui?
	if not playerGui then return end

	local existing = playerGui:FindFirstChild("VoicePinGui")
	if existing then existing:Destroy() end

	local screenGui = Instance.new("ScreenGui")
	screenGui.Name = "VoicePinGui"
	screenGui.ResetOnSpawn = false
	screenGui.DisplayOrder = 100

	local badge = Instance.new("Frame")
	badge.Name = "PinBadge"
	badge.AnchorPoint = Vector2.new(0.5, 0)
	badge.Position = UDim2.new(0.5, 0, 0, 12)
	badge.Size = UDim2.fromOffset(190, 40)
	badge.BackgroundColor3 = Color3.fromRGB(15, 23, 42)
	badge.BorderSizePixel = 0
	badge.Parent = screenGui

	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, 10)
	corner.Parent = badge

	local stroke = Instance.new("UIStroke")
	stroke.Color = Color3.fromRGB(59, 130, 246)
	stroke.Thickness = 1.5
	stroke.Transparency = 0.2
	stroke.Parent = badge

	local label = Instance.new("TextLabel")
	label.Name = "PinLabel"
	label.Size = UDim2.new(1, 0, 1, 0)
	label.BackgroundTransparency = 1
	label.Font = Enum.Font.GothamBold
	label.TextSize = 15
	label.TextColor3 = Color3.fromRGB(248, 250, 252)
	label.Text = string.format("🎙️ Voice PIN: %s", pin)
	label.Parent = badge

	screenGui.Parent = playerGui
end

local function onPlayerAdded(player: Player)
	local pin = generateUniquePin(player)
	createPinGui(player, pin)

	task.defer(function()
		-- إرسال رسالة توضيحية في الشات
		local TextChatService = game:GetService("TextChatService")
		if TextChatService.ChatVersion == Enum.ChatVersion.TextChatService then
			local channels = TextChatService:FindFirstChild("TextChannels") :: Folder?
			local general = channels and channels:FindFirstChild("RBXGeneral") :: TextChannel?
			if general then
				general:DisplaySystemMessage(string.format("[🎙️ Voice] رمز المايك الخاص بك هو: %s (اكتبه في صفحة الويب لتفعيل الصوت)", pin))
			end
		end
	end)
end

local function onPlayerRemoving(player: Player)
	local pin = playerPins[player.UserId]
	if pin then
		usedPins[pin] = nil
		playerPins[player.UserId] = nil
	end
end

Players.PlayerAdded:Connect(onPlayerAdded)
Players.PlayerRemoving:Connect(onPlayerRemoving)

for _, p in ipairs(Players:GetPlayers()) do
	onPlayerAdded(p)
end

-- ============================================================================
-- تجميع وإرسال إحداثيات اللاعبين إلى سيرفر FastAPI
-- ============================================================================
local function round2(n: number): number
	return math.round(n * 100) / 100
end

local function collectPlayerLocations(): { [string]: { pin: string, username: string, x: number, y: number, z: number, yaw: number } }
	local locations = {}

	for _, player in ipairs(Players:GetPlayers()) do
		local pin = playerPins[player.UserId]
		if not pin then continue end

		local character = player.Character
		if not character then continue end

		local rootPart = character:FindFirstChild("HumanoidRootPart") :: BasePart?
		local humanoid = character:FindFirstChildOfClass("Humanoid")

		if rootPart and humanoid and humanoid.Health > 0 then
			local pos = rootPart.Position
			local look = rootPart.CFrame.LookVector
			local yaw = math.atan2(look.X, -look.Z)

			locations[tostring(player.UserId)] = {
				pin = pin,
				username = player.DisplayName or player.Name,
				x = round2(pos.X),
				y = round2(pos.Y),
				z = round2(pos.Z),
				yaw = round2(yaw),
			}
		end
	end

	return locations
end

-- حلقة الإرسال التلقائي كل 0.5 ثانية
local isSending = false

task.spawn(function()
	print("[SpatialVoiceTracker] بدأ مزامنة الإحداثيات بالـ PIN ->", BACKEND_URL)

	while true do
		task.wait(UPDATE_INTERVAL)

		if isSending then continue end

		local payload = collectPlayerLocations()
		local jsonBody = HttpService:JSONEncode(payload)

		local headers: { [string]: string } = {}
		if SERVER_SECRET ~= "" then
			headers["X-Server-Secret"] = SERVER_SECRET
		end

		isSending = true
		task.spawn(function()
			local ok, err = pcall(function()
				HttpService:PostAsync(
					BACKEND_URL,
					jsonBody,
					Enum.HttpContentType.ApplicationJson,
					false,
					headers
				)
			end)

			if not ok then
				warn("[SpatialVoiceTracker] فشل إرسال الإحداثيات:", err)
			end
			isSending = false
		end)
	end
end)
