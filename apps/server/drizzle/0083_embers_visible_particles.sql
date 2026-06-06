-- Make the Embers particles actually visible at normal chat font
-- sizes. The 0.8-1.4px particle radii from 0082 were sub-pixel on
-- anything below browser zoom 200%, so the effect only resolved at
-- max zoom. Bump to 3-5px radii and let each particle's gradient
-- reach full opacity at center (the 70% transparent stop in 0082 ate
-- most of the visible dot anyway). Slightly taller rise distance so
-- the embers travel a meaningful path before fading, at the larger
-- radius they'd otherwise barely move before disappearing.
--
-- Positions on each pseudo stay roughly the same so the staggered-
-- timing illusion of randomness still holds; only the dot SIZE and
-- the TRAVEL distance change.

UPDATE `name_styles`
   SET `style_css` = '.ns-embers { position: relative; display: inline-block; background: linear-gradient(0deg, var(--user-color-2, #aa1500) 0%, var(--user-color-1, #ff6600) 45%, var(--user-glow, #ffcc44) 100%); background-size: 100% 220%; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; -webkit-text-stroke: 0.5px var(--user-outline, rgba(40,0,0,0.55)); animation: ns-embers-flame 2.8s ease-in-out infinite; filter: drop-shadow(0 -2px 5px var(--user-glow, rgba(255,140,50,0.7))); } @keyframes ns-embers-flame { 0%, 100% { background-position: 0% 100%; } 50% { background-position: 0% 30%; } } .ns-embers::before, .ns-embers::after { content: ""; position: absolute; inset: -22px -4px 0 -4px; pointer-events: none; background-repeat: no-repeat; } .ns-embers::before { background-image: radial-gradient(circle 4px at 18% 85%, var(--user-glow, rgba(255,200,100,1)), transparent 100%), radial-gradient(circle 3px at 52% 80%, var(--user-glow, rgba(255,170,80,0.95)), transparent 100%), radial-gradient(circle 5px at 81% 75%, var(--user-glow, rgba(255,220,130,0.95)), transparent 100%); animation: ns-embers-rise 2.6s linear infinite; } .ns-embers::after { background-image: radial-gradient(circle 3.5px at 33% 92%, var(--user-glow, rgba(255,180,90,0.9)), transparent 100%), radial-gradient(circle 4.5px at 67% 88%, var(--user-glow, rgba(255,210,110,0.9)), transparent 100%), radial-gradient(circle 3px at 92% 82%, var(--user-glow, rgba(255,160,60,0.95)), transparent 100%); animation: ns-embers-rise 3.8s linear infinite -1.3s; } @keyframes ns-embers-rise { 0% { transform: translateY(6px); opacity: 0; } 18% { opacity: 1; } 100% { transform: translateY(-22px); opacity: 0; } }'
 WHERE `key` = 'embers';
