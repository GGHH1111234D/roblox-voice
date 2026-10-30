// Figma UI Design System Generator
// Run this script in Figma: Plugins -> Development -> Open Console, then paste and press Enter!

(async function () {
    // 1. Setup Canvas & Load Fonts
    await figma.loadFontAsync({ family: "Inter", style: "Bold" });
    await figma.loadFontAsync({ family: "Inter", style: "Regular" });
    await figma.loadFontAsync({ family: "Inter", style: "Medium" });

    const page = figma.currentPage;

    // Helper: Hex to RGB
    function hexToRgb(hex) {
        let c = hex.replace("#", "");
        let num = parseInt(c, 16);
        return {
            r: ((num >> 16) & 255) / 255,
            g: ((num >> 8) & 255) / 255,
            b: (num & 255) / 255,
        };
    }

    // -------------------------------------------------------------
    // FRAME 1: SHOP MODAL (840 x 540)
    // -------------------------------------------------------------
    const shopFrame = figma.createFrame();
    shopFrame.name = "ShopModal_FigmaDesign";
    shopFrame.resize(840, 540);
    shopFrame.x = 100;
    shopFrame.y = 100;
    shopFrame.cornerRadius = 20;
    shopFrame.fills = [{ type: "SOLID", color: hexToRgb("#0B0D14") }];
    shopFrame.strokes = [{ type: "SOLID", color: hexToRgb("#2D364E") }];
    shopFrame.strokeWeight = 2;

    // Header
    const header = figma.createFrame();
    header.name = "HeaderBar";
    header.resize(840, 64);
    header.fills = [{ type: "SOLID", color: hexToRgb("#121520") }];
    shopFrame.appendChild(header);

    const title = figma.createText();
    title.fontName = { family: "Inter", style: "Bold" };
    title.characters = "💎 LUXURY BOUTIQUE • المتجر الحصري";
    title.fontSize = 16;
    title.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
    title.x = 24;
    title.y = 22;
    header.appendChild(title);

    // Tab Bar
    const tabBar = figma.createFrame();
    tabBar.name = "TabBar";
    tabBar.resize(800, 44);
    tabBar.x = 20;
    tabBar.y = 76;
    tabBar.fills = [];
    shopFrame.appendChild(tabBar);

    const tabs = ["⛓️ الكلبشات الحصرية", "🔫 ترسانة الأسلحة", "🛹 الأدوات الخاصة"];
    tabs.forEach((tName, i) => {
        const tabBtn = figma.createFrame();
        tabBtn.name = `Tab_${i + 1}`;
        tabBtn.resize(256, 44);
        tabBtn.x = i * 272;
        tabBtn.cornerRadius = 12;
        tabBtn.fills = [{ type: "SOLID", color: i === 0 ? hexToRgb("#2A3048") : hexToRgb("#141824") }];
        tabBtn.strokes = [{ type: "SOLID", color: i === 0 ? hexToRgb("#6366F1") : hexToRgb("#232A3C") }];
        tabBtn.strokeWeight = 1.5;

        const txt = figma.createText();
        txt.fontName = { family: "Inter", style: "Bold" };
        txt.characters = tName;
        txt.fontSize = 13;
        txt.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
        txt.x = 20;
        txt.y = 14;
        tabBtn.appendChild(txt);
        tabBar.appendChild(tabBtn);
    });

    // -------------------------------------------------------------
    // FRAME 2: 3D PRODUCT CARDS (3-COLUMN GRID)
    // -------------------------------------------------------------
    const sampleCards = [
        { title: "كلبشات الفولاذ", sub: "Steel Handcuffs", tier: "COMMON", tierColor: "#64748B", price: "149" },
        { title: "كلبشات التكتيك", sub: "Tactical Cyber Cuffs", tier: "TACTICAL", tierColor: "#0EA5E9", price: "399" },
        { title: "الكلبشات الذهبية", sub: "Royal Golden Cuffs", tier: "👑 VIP ROYAL", tierColor: "#F59E0B", price: "799" },
    ];

    sampleCards.forEach((cData, i) => {
        const card = figma.createFrame();
        card.name = `Card_${i + 1}`;
        card.resize(250, 350);
        card.x = 20 + i * 275;
        card.y = 136;
        card.cornerRadius = 16;
        card.fills = [{ type: "SOLID", color: hexToRgb("#121622") }];
        card.strokes = [{ type: "SOLID", color: hexToRgb("#283046") }];
        card.strokeWeight = 1.5;

        // Badge
        const badge = figma.createFrame();
        badge.resize(100, 24);
        badge.x = 12;
        badge.y = 12;
        badge.cornerRadius = 6;
        badge.fills = [{ type: "SOLID", color: hexToRgb(cData.tierColor) }];
        const bText = figma.createText();
        bText.fontName = { family: "Inter", style: "Bold" };
        bText.characters = cData.tier;
        bText.fontSize = 10;
        bText.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
        bText.x = 8;
        bText.y = 6;
        badge.appendChild(bText);
        card.appendChild(badge);

        // 3D Viewport Box
        const vp = figma.createFrame();
        vp.resize(226, 120);
        vp.x = 12;
        vp.y = 44;
        vp.cornerRadius = 12;
        vp.fills = [{ type: "SOLID", color: hexToRgb("#0D1019") }];
        card.appendChild(vp);

        // Card Title
        const cTitle = figma.createText();
        cTitle.fontName = { family: "Inter", style: "Bold" };
        cTitle.characters = cData.title;
        cTitle.fontSize = 14;
        cTitle.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
        cTitle.x = 12;
        cTitle.y = 176;
        card.appendChild(cTitle);

        // Subtitle
        const cSub = figma.createText();
        cSub.fontName = { family: "Inter", style: "Medium" };
        cSub.characters = cData.sub;
        cSub.fontSize = 11;
        cSub.fills = [{ type: "SOLID", color: hexToRgb("#94A3B8") }];
        cSub.x = 12;
        cSub.y = 198;
        card.appendChild(cSub);

        // Buy Button
        const buyBtn = figma.createFrame();
        buyBtn.resize(226, 42);
        buyBtn.x = 12;
        buyBtn.y = 286;
        buyBtn.cornerRadius = 10;
        buyBtn.fills = [{ type: "SOLID", color: hexToRgb("#6366F1") }];
        const btnText = figma.createText();
        btnText.fontName = { family: "Inter", style: "Bold" };
        btnText.characters = `R$ ${cData.price} شراء`;
        btnText.fontSize = 13;
        btnText.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
        btnText.x = 75;
        btnText.y = 13;
        buyBtn.appendChild(btnText);
        card.appendChild(buyBtn);

        shopFrame.appendChild(card);
    });

    // -------------------------------------------------------------
    // FRAME 3: FIGMA STOREFRONT BANNER (1000 x 220)
    // -------------------------------------------------------------
    const bannerFrame = figma.createFrame();
    bannerFrame.name = "StorefrontBanner_FigmaDesign";
    bannerFrame.resize(1000, 220);
    bannerFrame.x = 100;
    bannerFrame.y = 700;
    bannerFrame.cornerRadius = 16;
    bannerFrame.fills = [{ type: "SOLID", color: hexToRgb("#0F111A") }];
    bannerFrame.strokes = [{ type: "SOLID", color: hexToRgb("#FFD700") }];
    bannerFrame.strokeWeight = 5;

    const bTopGlow = figma.createFrame();
    bTopGlow.resize(1000, 6);
    bTopGlow.fills = [{ type: "SOLID", color: hexToRgb("#0EA5E9") }];
    bannerFrame.appendChild(bTopGlow);

    const bTitle = figma.createText();
    bTitle.fontName = { family: "Inter", style: "Bold" };
    bTitle.characters = "متجر الكلبشات الملكية";
    bTitle.fontSize = 48;
    bTitle.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
    bTitle.x = 280;
    bTitle.y = 45;
    bannerFrame.appendChild(bTitle);

    const bSub = figma.createText();
    bSub.fontName = { family: "Inter", style: "Bold" };
    bSub.characters = "CUFF BOUTIQUE • LUXURY RESTRAINT GEAR";
    bSub.fontSize = 24;
    bSub.fills = [{ type: "SOLID", color: hexToRgb("#0EA5E9") }];
    bSub.x = 220;
    bSub.y = 120;
    bannerFrame.appendChild(bSub);

    figma.notify("✨ Figma UI Design System generated successfully!");
})();
