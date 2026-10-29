--!strict
--[[
	SpatialVoiceServer.server.luau
	Placement: ServerScriptService/SpatialVoiceServer (Script)
	
	نظام الصوت المكاني ثلاثي الأبعاد (FastAPI + WebRTC 3D Spatial Audio)
	- يولد رمز PIN فريد مكون من 4 أرقام لكل لاعب فور دخوله (مثال: "PIN: 9714").
	- يسجل السمات (Attributes) على اللاعب:
	  * VoicePIN: رمز الربط للمايك
	  * IsVoiceConnected: هل اللاعب متصل بالمكالمة الصوتية
	  * IsSpeaking: هل يتحدث الآن
	  * IsMuted: هل هو مكتوم
	- يرسل إحداثيات اللاعبين ثلاثية الأبعاد (X, Y, Z, Yaw, PIN, Username) كل 0.5 ثانية إلى الخادم:
	  /update_locations
	- يستقبل قائمة activeVoicePins لتحديث حالة الاتصال وإخفاء رمز الـ PIN تلقائياً في اللعبة فور الاتصال!
]]

local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

--------------------------------------------------------------------------------
-- الإعدادات (CONFIGURATION)
--------------------------------------------------------------------------------
-- في الاستوديو المحلي: استخدم localhost:8000
-- عند اللعب على سيرفر روبلوكس لايف مع لاعبين آخرين: ضع رابط ngrok هنا
-- مثال: local BACKEND_URL = "https://xxxx-xx-xx.ngrok-free.app/update_locations"
local BACKEND_URL: string = "http://127.0.0.1:8000/update_locations"

local UPDATE_INTERVAL: number = 0.5 -- إرسال كل نصف ثانية (120 طلب/دقيقة - مسموح حتى 500 في روبلوكس)
local SERVER_SECRET: string = ""    -- اختياري؛ مطابق لـ ROBLOX_API_SECRET
local JOB_ID: string = if game.JobId ~= "" then game.JobId else ("studio-" .. HttpService:GenerateGUID(false))

--------------------------------------------------------------------------------
-- تهيئة مجلد الـ Remotes في ReplicatedStorage
--------------------------------------------------------------------------------
local remotesFolder = ReplicatedStorage:FindFirstChild("SpatialVoiceRemotes") :: Folder?
if not remotesFolder then
	local created = Instance.new("Folder")
	created.Name = "SpatialVoiceRemotes"
	created.Parent = ReplicatedStorage
	remotesFolder = created
end
assert(remotesFolder ~= nil)

local function ensureRemote(name: string, className: string): Instance
	local existing = remotesFolder:FindFirstChild(name)
	if existing and existing.ClassName == className then
		return existing
	end
	if existing then existing:Destroy() end
	local inst = Instance.new(className)
	inst.Name = name
	inst.Parent = remotesFolder
	return inst
end

local syncClientEvent = ensureRemote("SyncClientVoice", "RemoteEvent") :: RemoteEvent
local setTargetMuteEvent = ensureRemote("SetTargetMute", "RemoteEvent") :: RemoteEvent

--------------------------------------------------------------------------------
-- إدارة جلسات اللاعبين والـ PIN
--------------------------------------------------------------------------------
type PlayerSession = {
	player: Player,
	pin: string,
	inGameMuted: boolean,
	lookVec: Vector3,
	upVec: Vector3,
}

local sessions: { [Player]: PlayerSession } = {}
local rng = Random.new()
local usedPins: { [string]: boolean } = {}

local function generateUniquePin(): string
	local pin: string
	repeat
		pin = string.format("%04d", rng:NextInteger(1000, 9999))
	until not usedPins[pin]
	usedPins[pin] = true
	return pin
end

local function onPlayerAdded(player: Player)
	local pin = generateUniquePin()
	local session: PlayerSession = {
		player = player,
		pin = pin,
		inGameMuted = false,
		lookVec = Vector3.new(0, 0, -1),
		upVec = Vector3.new(0, 1, 0),
	}
	sessions[player] = session

	player:SetAttribute("VoicePIN", pin)
	player:SetAttribute("IsVoiceConnected", false)
	player:SetAttribute("IsSpeaking", false)
	player:SetAttribute("IsMuted", false)
	player:SetAttribute("InGameMuted", false)

	print(string.format("[SpatialVoiceServer] Player %s joined with Voice PIN: %s", player.Name, pin))
end

local function onPlayerRemoving(player: Player)
	local session = sessions[player]
	if session then
		usedPins[session.pin] = nil
		sessions[player] = nil
	end
end

Players.PlayerAdded:Connect(onPlayerAdded)
Players.PlayerRemoving:Connect(onPlayerRemoving)

for _, p in ipairs(Players:GetPlayers()) do
	task.spawn(onPlayerAdded, p)
end

-- استقبال حالة الكتم واتجاه الكاميرا من اللاعب
syncClientEvent.OnServerEvent:Connect(function(player: Player, lookVec: Vector3?, upVec: Vector3?, inGameMuted: boolean?)
	local session = sessions[player]
	if session then
		if typeof(inGameMuted) == "boolean" then
			session.inGameMuted = inGameMuted
			player:SetAttribute("InGameMuted", inGameMuted)
			player:SetAttribute("IsMuted", inGameMuted)
		end
		if typeof(lookVec) == "Vector3" then session.lookVec = lookVec end
		if typeof(upVec) == "Vector3" then session.upVec = upVec end
	end
end)

--------------------------------------------------------------------------------
-- جمع الإحداثيات وتجهيز حزمة الـ JSON
--------------------------------------------------------------------------------
type LocationEntry = {
	pin: string,
	username: string,
	x: number,
	y: number,
	z: number,
	yaw: number,
}

local function round2(n: number): number
	return math.round(n * 100) / 100
end

local function collectLocations(): { [string]: LocationEntry }
	local locations = {}
	for player, session in pairs(sessions) do
		local char = player.Character
		if not char then continue end
		local hrp = char:FindFirstChild("HumanoidRootPart") :: BasePart?
		local hum = char:FindFirstChildOfClass("Humanoid")
		if not hrp or not hum or hum.Health <= 0 then continue end

		local pos = hrp.Position
		local look = hrp.CFrame.LookVector
		local yaw = math.atan2(look.X, -look.Z)

		locations[tostring(player.UserId)] = {
			pin = session.pin,
			username = player.DisplayName,
			x = round2(pos.X),
			y = round2(pos.Y),
			z = round2(pos.Z),
			yaw = round2(yaw),
		}
	end
	return locations
end

--------------------------------------------------------------------------------
-- حلقة الإرسال التلقائي للـ Backend (0.5 ثانية)
--------------------------------------------------------------------------------
local isSending = false
local isShuttingDown = false
local consecutiveFailures = 0

-- تحذير استباقي إذا كان السيرفر لايف والرابط ما زال localhost
if not RunService:IsStudio() and (string.find(BACKEND_URL, "127.0.0.1", 1, true) or string.find(BACKEND_URL, "localhost", 1, true)) then
	warn("[SpatialVoiceServer] ⚠️ السيرفر يعمل كخادم حقيقي على روبلوكس (Cloud Server) بينما BACKEND_URL يشير إلى localhost! السيرفرات السحابية تحتاج رابط عام مثل ngrok.")
end

task.spawn(function()
	print(string.format("[SpatialVoiceServer] 🎙️ بدأ بث إحداثيات الصوت المكاني 3D كل %.1fs -> %s", UPDATE_INTERVAL, BACKEND_URL))
	
	while not isShuttingDown do
		task.wait(UPDATE_INTERVAL)
		if isSending then continue end

		local locs = collectLocations()
		local jsonBody = if next(locs) == nil then "{}" else HttpService:JSONEncode(locs)

		local headers: { [string]: string } = {
			["X-Job-Id"] = JOB_ID,
			["ngrok-skip-browser-warning"] = "true",
		}
		if SERVER_SECRET ~= "" then
			headers["X-Server-Secret"] = SERVER_SECRET
		end

		isSending = true
		task.spawn(function()
			local ok, res = pcall(function()
				return HttpService:PostAsync(
					BACKEND_URL,
					jsonBody,
					Enum.HttpContentType.ApplicationJson,
					false,
					headers
				)
			end)

			if ok and typeof(res) == "string" then
				if consecutiveFailures > 0 then
					print("[SpatialVoiceServer] ✅ عاد الاتصال بالخادم بنجاح.")
					consecutiveFailures = 0
				end

				local decodeOk, data = pcall(function()
					return HttpService:JSONDecode(res)
				end)

				if decodeOk and typeof(data) == "table" and typeof(data.activeVoicePins) == "table" then
					local activeSet = {}
					for _, p in ipairs(data.activeVoicePins) do
						activeSet[tostring(p)] = true
					end
					for player, session in pairs(sessions) do
						local isConnected = activeSet[session.pin] == true
						player:SetAttribute("IsVoiceConnected", isConnected)
					end
				end
			else
				consecutiveFailures += 1
				if consecutiveFailures == 1 or consecutiveFailures % 20 == 0 then
					warn(string.format("[SpatialVoiceServer] ⚠️ تعذر الاتصال بـ Backend (%d مرات): تأكد من تشغيل خادم FastAPI على البورت 8000.", consecutiveFailures))
				end
			end
			isSending = false
		end)
	end
end)

--------------------------------------------------------------------------------
-- التنظيف الفوري عند إغلاق السيرفر
--------------------------------------------------------------------------------
game:BindToClose(function()
	isShuttingDown = true
	pcall(function()
		HttpService:PostAsync(
			BACKEND_URL,
			"{}",
			Enum.HttpContentType.ApplicationJson,
			false,
			{ ["X-Job-Id"] = JOB_ID }
		)
	end)
end)
