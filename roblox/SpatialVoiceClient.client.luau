--!strict
--[[
	SpatialVoiceClient.client.luau
	Placement: StarterPlayer/StarterPlayerScripts/SpatialVoiceClient (LocalScript)

	Mobile-First External Roblox Spatial Voice System - Client Controller
	- Sleek topbar ScreenGui:
	  1. 4-digit PIN badge (auto-hides once IsVoiceConnected == true).
	  2. Circular Touch Mic Button (Green when active, Red when muted, pulsing border when speaking).
	- Rounded Overhead Mic Bubble (BillboardGui, StudsOffset = (0, 2.5, 0), MaxDistance = 60)
	  above each player's Head with tap-to-local-mute support.
	- Streams Camera LookVector/UpVector and inGameMuted state via RemoteEvent.
	- Zero external URLs or off-platform links (100% Roblox ToS compliant).
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local TweenService = game:GetService("TweenService")
local UserInputService = game:GetService("UserInputService")

local localPlayer = Players.LocalPlayer
local playerGui = localPlayer:WaitForChild("PlayerGui") :: PlayerGui

local remotesFolder = ReplicatedStorage:WaitForChild("SpatialVoiceRemotes", 30)
if not remotesFolder then
	warn("[SpatialVoiceClient] SpatialVoiceRemotes not found.")
	return
end

local syncClientEvent = remotesFolder:WaitForChild("SyncClientVoice") :: RemoteEvent
local setTargetMuteEvent = remotesFolder:WaitForChild("SetTargetMute") :: RemoteEvent

--------------------------------------------------------------------------------
-- CONSTANTS & STATE
--------------------------------------------------------------------------------
local CAMERA_SYNC_INTERVAL = 0.25
local BUBBLE_OFFSET = Vector3.new(0, 2.5, 0)
local BUBBLE_MAX_DISTANCE = 60
local PC_MUTE_KEY = Enum.KeyCode.V

local inGameMuted = localPlayer:GetAttribute("InGameMuted") == true
local locallyMutedPeers: { [string]: boolean } = {}
local overheadBubbles: { [Player]: BillboardGui } = {}

local COLORS = {
	HudBg = Color3.fromRGB(18, 20, 27),
	BubbleBg = Color3.fromRGB(20, 22, 28),
	Green = Color3.fromRGB(34, 197, 94),
	GreenBright = Color3.fromRGB(74, 222, 128),
	Red = Color3.fromRGB(239, 68, 68),
	Amber = Color3.fromRGB(251, 191, 36),
	White = Color3.fromRGB(248, 250, 252),
	MutedText = Color3.fromRGB(168, 178, 196),
	IdleSlate = Color3.fromRGB(115, 125, 142),
}

--------------------------------------------------------------------------------
-- VECTOR MICROPHONE ICON FACTORY (Reusable for Topbar Button & Overhead Bubble)
--------------------------------------------------------------------------------
local function buildMicVectorIcon(parent: Instance, scaleFactor: number): {
	root: Frame,
	capsule: Frame,
	fill: Frame,
	cupStroke: UIStroke,
	stem: Frame,
	base: Frame,
	slash: Frame,
}
	local function px(n: number): number
		return math.max(1, math.round(n * scaleFactor))
	end

	local root = Instance.new("Frame")
	root.Name = "MicVector"
	root.AnchorPoint = Vector2.new(0.5, 0.5)
	root.Position = UDim2.fromScale(0.5, 0.5)
	root.Size = UDim2.fromOffset(px(24), px(24))
	root.BackgroundTransparency = 1
	root.ZIndex = 4
	root.Parent = parent

	local capsule = Instance.new("Frame")
	capsule.Name = "Capsule"
	capsule.AnchorPoint = Vector2.new(0.5, 0.5)
	capsule.Position = UDim2.new(0.5, 0, 0.36, 0)
	capsule.Size = UDim2.fromOffset(px(7), px(12))
	capsule.BackgroundColor3 = COLORS.White
	capsule.BorderSizePixel = 0
	capsule.ClipsDescendants = true
	capsule.ZIndex = 5
	capsule.Parent = root

	local capCorner = Instance.new("UICorner")
	capCorner.CornerRadius = UDim.new(1, 0)
	capCorner.Parent = capsule

	local fill = Instance.new("Frame")
	fill.Name = "VoiceFill"
	fill.AnchorPoint = Vector2.new(0.5, 1)
	fill.Position = UDim2.fromScale(0.5, 1)
	fill.Size = UDim2.fromScale(1, 0.7)
	fill.BackgroundColor3 = COLORS.GreenBright
	fill.BorderSizePixel = 0
	fill.Visible = false
	fill.ZIndex = 6
	fill.Parent = capsule

	local fillCorner = Instance.new("UICorner")
	fillCorner.CornerRadius = UDim.new(1, 0)
	fillCorner.Parent = fill

	local cupClip = Instance.new("Frame")
	cupClip.Name = "CupClip"
	cupClip.AnchorPoint = Vector2.new(0.5, 0)
	cupClip.Position = UDim2.new(0.5, 0, 0.38, 0)
	cupClip.Size = UDim2.fromOffset(px(15), px(8))
	cupClip.BackgroundTransparency = 1
	cupClip.ClipsDescendants = true
	cupClip.ZIndex = 5
	cupClip.Parent = root

	local cupRing = Instance.new("Frame")
	cupRing.Name = "CupRing"
	cupRing.AnchorPoint = Vector2.new(0.5, 1)
	cupRing.Position = UDim2.fromScale(0.5, 1)
	cupRing.Size = UDim2.fromOffset(px(13), px(13))
	cupRing.BackgroundTransparency = 1
	cupRing.ZIndex = 5
	cupRing.Parent = cupClip

	local cupCorner = Instance.new("UICorner")
	cupCorner.CornerRadius = UDim.new(1, 0)
	cupCorner.Parent = cupRing

	local cupStroke = Instance.new("UIStroke")
	cupStroke.Color = COLORS.White
	cupStroke.Thickness = math.max(1.6, 1.8 * scaleFactor)
	cupStroke.Parent = cupRing

	local stem = Instance.new("Frame")
	stem.Name = "Stem"
	stem.AnchorPoint = Vector2.new(0.5, 0)
	stem.Position = UDim2.new(0.5, 0, 0.70, 0)
	stem.Size = UDim2.fromOffset(px(2), px(4))
	stem.BackgroundColor3 = COLORS.White
	stem.BorderSizePixel = 0
	stem.ZIndex = 5
	stem.Parent = root

	local base = Instance.new("Frame")
	base.Name = "Base"
	base.AnchorPoint = Vector2.new(0.5, 0.5)
	base.Position = UDim2.new(0.5, 0, 0.86, 0)
	base.Size = UDim2.fromOffset(px(8), px(2))
	base.BackgroundColor3 = COLORS.White
	base.BorderSizePixel = 0
	base.ZIndex = 5
	base.Parent = root

	local baseCorner = Instance.new("UICorner")
	baseCorner.CornerRadius = UDim.new(1, 0)
	baseCorner.Parent = base

	local slash = Instance.new("Frame")
	slash.Name = "MuteSlash"
	slash.AnchorPoint = Vector2.new(0.5, 0.5)
	slash.Position = UDim2.fromScale(0.5, 0.5)
	slash.Size = UDim2.fromOffset(px(22), math.max(2, px(3)))
	slash.Rotation = -45
	slash.BackgroundColor3 = COLORS.White
	slash.BorderSizePixel = 0
	slash.Visible = false
	slash.ZIndex = 8
	slash.Parent = root

	local slashCorner = Instance.new("UICorner")
	slashCorner.CornerRadius = UDim.new(1, 0)
	slashCorner.Parent = slash

	local slashOutline = Instance.new("UIStroke")
	slashOutline.Color = COLORS.BubbleBg
	slashOutline.Thickness = 1.3
	slashOutline.Parent = slash

	return {
		root = root,
		capsule = capsule,
		fill = fill,
		cupStroke = cupStroke,
		stem = stem,
		base = base,
		slash = slash,
	}
end

--------------------------------------------------------------------------------
-- 1. MOBILE-FRIENDLY TOP-BAR HUD & TOUCH MIC BUTTON
--------------------------------------------------------------------------------
for _, oldName in ipairs({ "SpatialVoiceHUD", "MobileSpatialVoiceHUD", "SpatialVoiceBubbles" }) do
	local old = playerGui:FindFirstChild(oldName)
	if old then
		old:Destroy()
	end
end

local screenGui = Instance.new("ScreenGui")
screenGui.Name = "MobileSpatialVoiceHUD"
screenGui.ResetOnSpawn = false
screenGui.IgnoreGuiInset = true
screenGui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
screenGui.DisplayOrder = 60
screenGui.Parent = playerGui

local bubblesFolder = Instance.new("Folder")
bubblesFolder.Name = "SpatialVoiceBubbles"
bubblesFolder.Parent = playerGui

-- Sleek Top-Bar Container positioned cleanly near Roblox Topbar
local topContainer = Instance.new("Frame")
topContainer.Name = "TopVoiceBar"
topContainer.AnchorPoint = Vector2.new(0.5, 0)
topContainer.Position = UDim2.new(0.5, 0, 0, 8)
topContainer.AutomaticSize = Enum.AutomaticSize.X
topContainer.Size = UDim2.fromOffset(0, 48)
topContainer.BackgroundTransparency = 1
topContainer.Parent = screenGui

local barLayout = Instance.new("UIListLayout")
barLayout.FillDirection = Enum.FillDirection.Horizontal
barLayout.HorizontalAlignment = Enum.HorizontalAlignment.Center
barLayout.VerticalAlignment = Enum.VerticalAlignment.Center
barLayout.Padding = UDim.new(0, 8)
barLayout.SortOrder = Enum.SortOrder.LayoutOrder
barLayout.Parent = topContainer

-- Circular In-Game Touch Mic Toggle Button (46x46 oversized mobile touch target)
local micTouchWrap = Instance.new("Frame")
micTouchWrap.Name = "MicTouchWrap"
micTouchWrap.LayoutOrder = 1
micTouchWrap.Size = UDim2.fromOffset(48, 48)
micTouchWrap.BackgroundTransparency = 1
micTouchWrap.Parent = topContainer

local hudPulseRing = Instance.new("Frame")
hudPulseRing.Name = "PulseRing"
hudPulseRing.AnchorPoint = Vector2.new(0.5, 0.5)
hudPulseRing.Position = UDim2.fromScale(0.5, 0.5)
hudPulseRing.Size = UDim2.fromOffset(44, 44)
hudPulseRing.BackgroundTransparency = 1
hudPulseRing.Parent = micTouchWrap

local hudPulseCorner = Instance.new("UICorner")
hudPulseCorner.CornerRadius = UDim.new(1, 0)
hudPulseCorner.Parent = hudPulseRing

local hudPulseStroke = Instance.new("UIStroke")
hudPulseStroke.Color = COLORS.GreenBright
hudPulseStroke.Thickness = 2.5
hudPulseStroke.Transparency = 1
hudPulseStroke.Parent = hudPulseRing

local micTouchBtn = Instance.new("TextButton")
micTouchBtn.Name = "TouchMicButton"
micTouchBtn.AnchorPoint = Vector2.new(0.5, 0.5)
micTouchBtn.Position = UDim2.fromScale(0.5, 0.5)
micTouchBtn.Size = UDim2.fromOffset(44, 44)
micTouchBtn.BackgroundColor3 = COLORS.HudBg
micTouchBtn.BackgroundTransparency = 0.08
micTouchBtn.BorderSizePixel = 0
micTouchBtn.AutoButtonColor = false
micTouchBtn.Text = ""
micTouchBtn.ZIndex = 3
micTouchBtn.Parent = micTouchWrap

local micBtnScale = Instance.new("UIScale")
micBtnScale.Scale = 1
micBtnScale.Parent = micTouchBtn

local micBtnCorner = Instance.new("UICorner")
micBtnCorner.CornerRadius = UDim.new(1, 0)
micBtnCorner.Parent = micTouchBtn

local micBtnStroke = Instance.new("UIStroke")
micBtnStroke.Color = COLORS.IdleSlate
micBtnStroke.Thickness = 2
micBtnStroke.Transparency = 0.25
micBtnStroke.Parent = micTouchBtn

local hudMicIcon = buildMicVectorIcon(micTouchBtn, 1.05)

-- PIN Badge (Clickable TextButton: tap to hide/show PIN, and auto-hides when connected!)
local pinBadge = Instance.new("TextButton")
pinBadge.Name = "PinBadge"
pinBadge.LayoutOrder = 2
pinBadge.AutomaticSize = Enum.AutomaticSize.X
pinBadge.Size = UDim2.fromOffset(0, 40)
pinBadge.BackgroundColor3 = COLORS.HudBg
pinBadge.BackgroundTransparency = 0.08
pinBadge.BorderSizePixel = 0
pinBadge.Text = ""
pinBadge.AutoButtonColor = false
pinBadge.Parent = topContainer

local pinBadgeCorner = Instance.new("UICorner")
pinBadgeCorner.CornerRadius = UDim.new(1, 0)
pinBadgeCorner.Parent = pinBadge

local pinBadgeStroke = Instance.new("UIStroke")
pinBadgeStroke.Color = COLORS.Amber
pinBadgeStroke.Thickness = 1.4
pinBadgeStroke.Transparency = 0.45
pinBadgeStroke.Parent = pinBadge

local pinPadding = Instance.new("UIPadding")
pinPadding.PaddingLeft = UDim.new(0, 14)
pinPadding.PaddingRight = UDim.new(0, 14)
pinPadding.Parent = pinBadge

local pinLabel = Instance.new("TextLabel")
pinLabel.Name = "PinText"
pinLabel.AutomaticSize = Enum.AutomaticSize.X
pinLabel.Size = UDim2.new(0, 0, 1, 0)
pinLabel.BackgroundTransparency = 1
pinLabel.Font = Enum.Font.GothamBold
pinLabel.TextSize = 14
pinLabel.TextColor3 = COLORS.Amber
pinLabel.Text = "PIN: ----"
pinLabel.Parent = pinBadge

-- Temporary Feedback Pill for Tap-to-Mute notifications
local toastBadge = Instance.new("TextLabel")
toastBadge.Name = "ToastBadge"
toastBadge.AnchorPoint = Vector2.new(0.5, 0)
toastBadge.Position = UDim2.new(0.5, 0, 0, 60)
toastBadge.AutomaticSize = Enum.AutomaticSize.X
toastBadge.Size = UDim2.fromOffset(0, 26)
toastBadge.BackgroundColor3 = COLORS.HudBg
toastBadge.BackgroundTransparency = 0.12
toastBadge.Font = Enum.Font.GothamSemibold
toastBadge.TextSize = 12
toastBadge.TextColor3 = COLORS.White
toastBadge.Text = ""
toastBadge.Visible = false
toastBadge.Parent = screenGui

local toastCorner = Instance.new("UICorner")
toastCorner.CornerRadius = UDim.new(1, 0)
toastCorner.Parent = toastBadge

local toastPad = Instance.new("UIPadding")
toastPad.PaddingLeft = UDim.new(0, 12)
toastPad.PaddingRight = UDim.new(0, 12)
toastPad.Parent = toastBadge

local toastToken = 0
local function showToast(text: string, color: Color3)
	toastToken += 1
	local myToken = toastToken
	toastBadge.Text = text
	toastBadge.TextColor3 = color
	toastBadge.Visible = true
	task.delay(1.8, function()
		if toastToken == myToken then
			toastBadge.Visible = false
		end
	end)
end

-- ميزة وضع البث ومشاركة الشاشة (Streamer Mode / Share Screen Protection)
local pinHiddenByUser = false

local function updatePinText()
	local pin = tostring(localPlayer:GetAttribute("VoicePIN") or "----")
	if pinHiddenByUser then
		pinLabel.Text = "🔒 PIN: ••••"
		pinBadgeStroke.Transparency = 0.85
		pinLabel.TextColor3 = COLORS.MutedText
	else
		pinLabel.Text = string.format("👁️ PIN: %s", pin)
		pinBadgeStroke.Transparency = 0.45
		pinLabel.TextColor3 = COLORS.Amber
	end
end

local function togglePinMask()
	pinHiddenByUser = not pinHiddenByUser
	-- تأثير حركة النقر (Bounce Scale)
	local scale = pinBadge:FindFirstChildOfClass("UIScale")
	if not scale then
		scale = Instance.new("UIScale")
		scale.Parent = pinBadge
	end
	scale.Scale = 0.92
	TweenService:Create(scale, TweenInfo.new(0.15, Enum.EasingStyle.Back), { Scale = 1 }):Play()

	updatePinText()
	if pinHiddenByUser then
		showToast("🔒 تم إخفاء الرمز لحماية البث المباشر (Share Screen)", COLORS.Amber)
	else
		showToast("👁️ تم إظهار رمز الـ PIN", COLORS.Green)
	end
end

-- الضغط بالماوس أو اللمس على الشارة
pinBadge.Activated:Connect(togglePinMask)

-- اختصار كيبورد للكمبيوتر: اضغط حرف [H] لإخفاء أو إظهار الرمز فوراً
UserInputService.InputBegan:Connect(function(input, gameProcessed)
	if gameProcessed then return end
	if input.KeyCode == Enum.KeyCode.H then
		togglePinMask()
	end
end)



local function refreshHudVisuals()
	local pin = tostring(localPlayer:GetAttribute("VoicePIN") or "----")
	local isConnected = localPlayer:GetAttribute("IsVoiceConnected") == true
	local isSpeaking = localPlayer:GetAttribute("IsSpeaking") == true
	local isMuted = (localPlayer:GetAttribute("IsMuted") == true) or inGameMuted

	updatePinText()
	-- Automatically hide PIN badge once webState confirms player is connected
	pinBadge.Visible = not isConnected

	if isMuted then
		micTouchBtn.BackgroundColor3 = COLORS.Red
		micTouchBtn.BackgroundTransparency = 0.05
		micBtnStroke.Color = COLORS.White
		micBtnStroke.Thickness = 2
		micBtnStroke.Transparency = 0.35
		hudMicIcon.fill.Visible = false
		hudMicIcon.slash.Visible = true
		hudMicIcon.slash.BackgroundColor3 = COLORS.White
	elseif isConnected then
		micTouchBtn.BackgroundColor3 = COLORS.Green
		micTouchBtn.BackgroundTransparency = 0.05
		micBtnStroke.Color = if isSpeaking then COLORS.White else COLORS.GreenBright
		micBtnStroke.Thickness = if isSpeaking then 2.8 else 2
		micBtnStroke.Transparency = if isSpeaking then 0 else 0.25
		hudMicIcon.fill.Visible = isSpeaking
		hudMicIcon.slash.Visible = false
	else
		micTouchBtn.BackgroundColor3 = COLORS.HudBg
		micTouchBtn.BackgroundTransparency = 0.1
		micBtnStroke.Color = COLORS.IdleSlate
		micBtnStroke.Thickness = 1.8
		micBtnStroke.Transparency = 0.35
		hudMicIcon.fill.Visible = false
		hudMicIcon.slash.Visible = false
	end
end

local function sendStateToServer()
	local cam = workspace.CurrentCamera
	local look = if cam then cam.CFrame.LookVector else Vector3.new(0, 0, -1)
	local up = if cam then cam.CFrame.UpVector else Vector3.new(0, 1, 0)
	syncClientEvent:FireServer(look, up, inGameMuted)
end

local function toggleInGameMute()
	inGameMuted = not inGameMuted
	micBtnScale.Scale = 0.86
	TweenService:Create(micBtnScale, TweenInfo.new(0.16, Enum.EasingStyle.Back), { Scale = 1 }):Play()
	refreshHudVisuals()
	sendStateToServer()
	showToast(
		if inGameMuted then "Mic Muted" else "Mic Active",
		if inGameMuted then COLORS.Red else COLORS.GreenBright
	)
end

micTouchBtn.Activated:Connect(toggleInGameMute)

UserInputService.InputBegan:Connect(function(input: InputObject, processed: boolean)
	if processed or UserInputService:GetFocusedTextBox() ~= nil then
		return
	end
	if input.KeyCode == PC_MUTE_KEY then
		toggleInGameMute()
	end
end)

for _, attrName in ipairs({ "VoicePIN", "IsVoiceConnected", "IsSpeaking", "IsMuted", "InGameMuted" }) do
	localPlayer:GetAttributeChangedSignal(attrName):Connect(function()
		if attrName == "InGameMuted" then
			inGameMuted = localPlayer:GetAttribute("InGameMuted") == true
		end
		refreshHudVisuals()
	end)
end
refreshHudVisuals()

--------------------------------------------------------------------------------
-- 2. ROBLOX-STYLE OVERHEAD MIC BUBBLE (BillboardGui)
--------------------------------------------------------------------------------
local function updateOverheadBubble(targetPlayer: Player)
	local billboard = overheadBubbles[targetPlayer]
	if not billboard then
		return
	end

	local main = billboard:FindFirstChild("BubbleFrame") :: Frame?
	if not main then
		return
	end

	local stroke = main:FindFirstChild("BubbleStroke") :: UIStroke?
	local tail = billboard:FindFirstChild("Tail") :: Frame?
	local activeDot = main:FindFirstChild("ActiveDot") :: Frame?
	local micVec = main:FindFirstChild("MicVector") :: Frame?
	local cap = micVec and micVec:FindFirstChild("Capsule") :: Frame?
	local fill = cap and cap:FindFirstChild("VoiceFill") :: Frame?
	local cupClip = micVec and micVec:FindFirstChild("CupClip") :: Frame?
	local cupRing = cupClip and cupClip:FindFirstChild("CupRing") :: Frame?
	local cupStroke = cupRing and cupRing:FindFirstChild("UIStroke") :: UIStroke?
	local stem = micVec and micVec:FindFirstChild("Stem") :: Frame?
	local base = micVec and micVec:FindFirstChild("Base") :: Frame?
	local slash = micVec and micVec:FindFirstChild("MuteSlash") :: Frame?

	local tKey = string.lower(targetPlayer.Name)
	local isLocalMuted = (targetPlayer ~= localPlayer) and (locallyMutedPeers[tKey] == true)
	local connected = targetPlayer:GetAttribute("IsVoiceConnected") == true
	local speaking = targetPlayer:GetAttribute("IsSpeaking") == true
	local muted = (targetPlayer:GetAttribute("IsMuted") == true) or isLocalMuted

	-- Show bubble cleanly when connected (or muted locally); subtle dimmed state when disconnected
	billboard:SetAttribute("AnimateSpeak", connected and speaking and (not muted))

	local function paintIcon(col: Color3, trans: number)
		if cap then cap.BackgroundColor3 = col; cap.BackgroundTransparency = trans end
		if cupStroke then cupStroke.Color = col; cupStroke.Transparency = trans end
		if stem then stem.BackgroundColor3 = col; stem.BackgroundTransparency = trans end
		if base then base.BackgroundColor3 = col; base.BackgroundTransparency = trans end
	end

	if muted and (connected or isLocalMuted) then
		-- Muted: Red muted mic icon + red border
		main.BackgroundColor3 = COLORS.BubbleBg
		main.BackgroundTransparency = 0.14
		if tail then tail.BackgroundColor3 = COLORS.BubbleBg; tail.BackgroundTransparency = 0.14 end
		if stroke then stroke.Color = COLORS.Red; stroke.Thickness = 2.2; stroke.Transparency = 0.15 end
		paintIcon(COLORS.Red, 0)
		if fill then fill.Visible = false end
		if slash then slash.Visible = true; slash.BackgroundColor3 = COLORS.Red end
		if activeDot then activeDot.Visible = true; activeDot.BackgroundColor3 = COLORS.Red end
	local eqWrap = main:FindFirstChild("EqWrap") :: Frame?

	if muted and (connected or isLocalMuted) then
		-- Muted: Red muted mic icon + red border
		main.BackgroundColor3 = COLORS.BubbleBg
		main.BackgroundTransparency = 0.14
		if tail then tail.BackgroundColor3 = COLORS.BubbleBg; tail.BackgroundTransparency = 0.14 end
		if stroke then stroke.Color = COLORS.Red; stroke.Thickness = 2.2; stroke.Transparency = 0.15 end
		paintIcon(COLORS.Red, 0)
		if micVec then micVec.Visible = true end
		if eqWrap then eqWrap.Visible = false end
		if fill then fill.Visible = false end
		if slash then slash.Visible = true; slash.BackgroundColor3 = COLORS.Red end
		if activeDot then activeDot.Visible = true; activeDot.BackgroundColor3 = COLORS.Red end
	elseif connected and speaking then
		-- Speaking: Glowing green border, dancing equalizer bars, and pulsing halo
		main.BackgroundColor3 = COLORS.BubbleBg
		main.BackgroundTransparency = 0.10
		if tail then tail.BackgroundColor3 = COLORS.BubbleBg; tail.BackgroundTransparency = 0.10 end
		if stroke then stroke.Color = COLORS.GreenBright; stroke.Thickness = 2.6; stroke.Transparency = 0 end
		if micVec then micVec.Visible = false end
		if eqWrap then eqWrap.Visible = true end
		if activeDot then activeDot.Visible = true; activeDot.BackgroundColor3 = COLORS.GreenBright end
	elseif connected then
		-- Connected & Silent: Dark translucent bubble with crisp white mic icon
		main.BackgroundColor3 = COLORS.BubbleBg
		main.BackgroundTransparency = 0.18
		if tail then tail.BackgroundColor3 = COLORS.BubbleBg; tail.BackgroundTransparency = 0.18 end
		if stroke then stroke.Color = COLORS.White; stroke.Thickness = 1.8; stroke.Transparency = 0.4 end
		paintIcon(COLORS.White, 0)
		if micVec then micVec.Visible = true end
		if eqWrap then eqWrap.Visible = false end
		if fill then fill.Visible = false end
		if slash then slash.Visible = false end
		if activeDot then activeDot.Visible = false end
	else
		-- Disconnected idle indicator
		main.BackgroundColor3 = COLORS.BubbleBg
		main.BackgroundTransparency = 0.55
		if tail then tail.BackgroundColor3 = COLORS.BubbleBg; tail.BackgroundTransparency = 0.55 end
		if stroke then stroke.Color = COLORS.IdleSlate; stroke.Thickness = 1.2; stroke.Transparency = 0.75 end
		paintIcon(COLORS.IdleSlate, 0.4)
		if fill then fill.Visible = false end
		if slash then slash.Visible = false end
		if activeDot then activeDot.Visible = false end
	end
end

local function attachBubbleToHead(targetPlayer: Player, head: BasePart)
	local prev = overheadBubbles[targetPlayer]
	if prev then
		prev:Destroy()
	end

	local billboard = Instance.new("BillboardGui")
	billboard.Name = "OverheadVoice_" .. targetPlayer.Name
	billboard.Adornee = head
	billboard.Active = true
	billboard.AlwaysOnTop = true
	billboard.StudsOffset = BUBBLE_OFFSET
	billboard.MaxDistance = BUBBLE_MAX_DISTANCE
	billboard.Size = UDim2.fromOffset(48, 52)
	billboard.LightInfluence = 0
	billboard.ResetOnSpawn = false
	billboard.Parent = bubblesFolder

	local halo = Instance.new("Frame")
	halo.Name = "PulseHalo"
	halo.AnchorPoint = Vector2.new(0.5, 0.5)
	halo.Position = UDim2.new(0.5, 0, 0.46, 0)
	halo.Size = UDim2.fromOffset(38, 38)
	halo.BackgroundTransparency = 1
	halo.Parent = billboard

	local haloCorner = Instance.new("UICorner")
	haloCorner.CornerRadius = UDim.new(1, 0)
	haloCorner.Parent = halo

	local haloStroke = Instance.new("UIStroke")
	haloStroke.Name = "HaloStroke"
	haloStroke.Color = COLORS.GreenBright
	haloStroke.Thickness = 2
	haloStroke.Transparency = 1
	haloStroke.Parent = halo

	local tail = Instance.new("Frame")
	tail.Name = "Tail"
	tail.AnchorPoint = Vector2.new(0.5, 0.5)
	tail.Position = UDim2.new(0.5, 0, 0.80, 0)
	tail.Size = UDim2.fromOffset(8, 8)
	tail.Rotation = 45
	tail.BackgroundColor3 = COLORS.BubbleBg
	tail.BackgroundTransparency = 0.22
	tail.BorderSizePixel = 0
	tail.ZIndex = 1
	tail.Parent = billboard

	local tailCorner = Instance.new("UICorner")
	tailCorner.CornerRadius = UDim.new(0, 2)
	tailCorner.Parent = tail

	local main = Instance.new("Frame")
	main.Name = "BubbleFrame"
	main.AnchorPoint = Vector2.new(0.5, 0.5)
	main.Position = UDim2.new(0.5, 0, 0.46, 0)
	main.Size = UDim2.fromOffset(38, 38)
	main.BackgroundColor3 = COLORS.BubbleBg
	main.BackgroundTransparency = 0.22
	main.BorderSizePixel = 0
	main.ZIndex = 2
	main.Parent = billboard

	local mainCorner = Instance.new("UICorner")
	mainCorner.CornerRadius = UDim.new(1, 0)
	mainCorner.Parent = main

	local stroke = Instance.new("UIStroke")
	stroke.Name = "BubbleStroke"
	stroke.Color = COLORS.White
	stroke.Thickness = 1.5
	stroke.Transparency = 0.72
	stroke.Parent = main

	local bubbleScale = Instance.new("UIScale")
	bubbleScale.Name = "BubbleScale"
	bubbleScale.Scale = 1
	bubbleScale.Parent = main

	buildMicVectorIcon(main, 0.95)

	-- 3-bar animated Voice Equalizer for speaking animation
	local eqWrap = Instance.new("Frame")
	eqWrap.Name = "EqWrap"
	eqWrap.AnchorPoint = Vector2.new(0.5, 0.5)
	eqWrap.Position = UDim2.fromScale(0.5, 0.5)
	eqWrap.Size = UDim2.fromOffset(20, 16)
	eqWrap.BackgroundTransparency = 1
	eqWrap.Visible = false
	eqWrap.ZIndex = 7
	eqWrap.Parent = main

	local eqLayout = Instance.new("UIListLayout")
	eqLayout.FillDirection = Enum.FillDirection.Horizontal
	eqLayout.HorizontalAlignment = Enum.HorizontalAlignment.Center
	eqLayout.VerticalAlignment = Enum.VerticalAlignment.Center
	eqLayout.Padding = UDim.new(0, 3)
	eqLayout.SortOrder = Enum.SortOrder.LayoutOrder
	eqLayout.Parent = eqWrap

	for i = 1, 3 do
		local bar = Instance.new("Frame")
		bar.Name = "Bar" .. i
		bar.LayoutOrder = i
		bar.Size = UDim2.fromOffset(3, 8)
		bar.BackgroundColor3 = COLORS.GreenBright
		bar.BorderSizePixel = 0
		bar.ZIndex = 8
		bar.Parent = eqWrap

		local barCorner = Instance.new("UICorner")
		barCorner.CornerRadius = UDim.new(1, 0)
		barCorner.Parent = bar
	end

	local activeDot = Instance.new("Frame")
	activeDot.Name = "ActiveDot"
	activeDot.AnchorPoint = Vector2.new(1, 1)
	activeDot.Position = UDim2.new(1, -1, 1, -1)
	activeDot.Size = UDim2.fromOffset(9, 9)
	activeDot.BackgroundColor3 = COLORS.GreenBright
	activeDot.BorderSizePixel = 0
	activeDot.Visible = false
	activeDot.ZIndex = 9
	activeDot.Parent = main

	local dotCorner = Instance.new("UICorner")
	dotCorner.CornerRadius = UDim.new(1, 0)
	dotCorner.Parent = activeDot

	local dotStroke = Instance.new("UIStroke")
	dotStroke.Color = COLORS.BubbleBg
	dotStroke.Thickness = 1.5
	dotStroke.Parent = activeDot

	local tapBtn = Instance.new("TextButton")
	tapBtn.Name = "TapHitbox"
	tapBtn.Size = UDim2.fromScale(1, 1)
	tapBtn.BackgroundTransparency = 1
	tapBtn.Text = ""
	tapBtn.ZIndex = 15
	tapBtn.Parent = main

	tapBtn.Activated:Connect(function()
		if targetPlayer == localPlayer then
			toggleInGameMute()
		else
			local tKey = string.lower(targetPlayer.Name)
			local nowMuted = not (locallyMutedPeers[tKey] == true)
			locallyMutedPeers[tKey] = if nowMuted then true else nil
			updateOverheadBubble(targetPlayer)
			setTargetMuteEvent:FireServer(tKey, nowMuted)
			showToast(
				if nowMuted then ("Muted @" .. targetPlayer.DisplayName) else ("Unmuted @" .. targetPlayer.DisplayName),
				if nowMuted then COLORS.Red else COLORS.GreenBright
			)
		end
	end)

	overheadBubbles[targetPlayer] = billboard
	updateOverheadBubble(targetPlayer)
end

local function trackPlayer(p: Player)
	local function onCharacter(char: Model)
		local head = (char:FindFirstChild("Head") or char:WaitForChild("Head", 10)) :: BasePart?
		if head and p.Parent == Players then
			attachBubbleToHead(p, head)
		end
	end

	p.CharacterAdded:Connect(onCharacter)
	if p.Character then
		task.spawn(onCharacter, p.Character)
	end

	for _, attr in ipairs({ "IsVoiceConnected", "IsSpeaking", "IsMuted" }) do
		p:GetAttributeChangedSignal(attr):Connect(function()
			updateOverheadBubble(p)
		end)
	end
end

Players.PlayerAdded:Connect(trackPlayer)
Players.PlayerRemoving:Connect(function(p: Player)
	local b = overheadBubbles[p]
	if b then
		b:Destroy()
		overheadBubbles[p] = nil
	end
	locallyMutedPeers[string.lower(p.Name)] = nil
end)
for _, existing in ipairs(Players:GetPlayers()) do
	task.spawn(trackPlayer, existing)
end

--------------------------------------------------------------------------------
-- 3. CAMERA STREAMING & 60 FPS SPEAKING PULSE ANIMATION
--------------------------------------------------------------------------------
task.spawn(function()
	while true do
		sendStateToServer()
		task.wait(CAMERA_SYNC_INTERVAL)
	end
end)

RunService.RenderStepped:Connect(function()
	local t = os.clock()
	local wave = (math.sin(t * 9.5) + 1) * 0.5

	-- Animate Topbar Touch Mic Button when speaking
	local selfSpeaking = (localPlayer:GetAttribute("IsVoiceConnected") == true)
		and (localPlayer:GetAttribute("IsSpeaking") == true)
		and (not inGameMuted)
		and (localPlayer:GetAttribute("IsMuted") ~= true)

	if selfSpeaking then
		local ringSize = math.round(46 + wave * 10)
		hudPulseRing.Size = UDim2.fromOffset(ringSize, ringSize)
		hudPulseStroke.Transparency = 0.15 + wave * 0.65
	else
		hudPulseRing.Size = UDim2.fromOffset(44, 44)
		hudPulseStroke.Transparency = 1
	end

	-- Animate Overhead Voice Bubbles (Dancing Equalizer Bars + Bubble Scale Bobbing + Pulse Halo)
	for _, billboard in pairs(overheadBubbles) do
		local main = billboard:FindFirstChild("BubbleFrame") :: Frame?
		local bubbleScale = main and main:FindFirstChild("BubbleScale") :: UIScale?
		local halo = billboard:FindFirstChild("PulseHalo") :: Frame?
		local haloStroke = halo and halo:FindFirstChild("HaloStroke") :: UIStroke?
		local eqWrap = main and main:FindFirstChild("EqWrap") :: Frame?
		local isSpeaking = billboard:GetAttribute("AnimateSpeak") == true

		if isSpeaking then
			if bubbleScale then
				bubbleScale.Scale = 1.05 + math.sin(t * 11) * 0.07
			end
			if halo and haloStroke then
				local s = math.round(38 + wave * 14)
				halo.Size = UDim2.fromOffset(s, s)
				haloStroke.Transparency = 0.1 + wave * 0.75
			end
			if eqWrap then
				local bar1 = eqWrap:FindFirstChild("Bar1") :: Frame?
				local bar2 = eqWrap:FindFirstChild("Bar2") :: Frame?
				local bar3 = eqWrap:FindFirstChild("Bar3") :: Frame?
				if bar1 then bar1.Size = UDim2.fromOffset(3, math.round(5 + (math.sin(t * 16) + 1) * 4)) end
				if bar2 then bar2.Size = UDim2.fromOffset(3, math.round(7 + (math.sin(t * 22 + 1.2) + 1) * 5)) end
				if bar3 then bar3.Size = UDim2.fromOffset(3, math.round(4 + (math.sin(t * 18 + 2.5) + 1) * 4.5)) end
			end
		else
			if bubbleScale then
				bubbleScale.Scale = 1
			end
			if halo and haloStroke then
				halo.Size = UDim2.fromOffset(38, 38)
				haloStroke.Transparency = 1
			end
		end
	end
end)
