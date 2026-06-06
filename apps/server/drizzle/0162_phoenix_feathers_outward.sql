-- Push the Phoenix-plumage border's feathers further out from the
-- avatar so they read as a distinct spinning ring of feathers rather
-- than dissolving into the .av frame's orange glow.
--
-- Before: feathers were 5x10px positioned at radius 44px from center.
-- The .av frame has radius 42px (84px diameter from the preamble), so
-- each feather sat only 2px outside the frame edge, well within the
-- orange ring + box-shadow bloom, which made them visually merge into
-- the glow at every render size. With a real avatar inside the .pic,
-- the user can see the ring but not the feathers that are supposed to
-- circle it.
--
-- After: feathers are 6x14px positioned at radius 52px from center.
-- That's 10px outside the .av edge, comfortably beyond the box-
-- shadow falloff. The larger silhouette and slightly bolder drop-
-- shadow keep them legible at the inline sm/md scale while still
-- looking sharp at xl showcase scale.

UPDATE `freeform_borders`
SET `style_css` = '.b-phoenix-v4 { padding: 2px; background: conic-gradient(from 90deg, #ff1744, #ff6f00, #ffab00, #ff3d00, #ff1744); animation: phx4Spin 6s linear infinite; box-shadow: 0 0 10px rgba(255,87,34,.55), inset 0 0 6px rgba(255,193,7,.35); }
.b-phoenix-v4::before { content: ""; position: absolute; inset: -2px; border-radius: 50%; background: radial-gradient(circle, rgba(255,109,0,.35), transparent 65%); animation: phx4Aura 2.2s ease-in-out infinite; pointer-events: none; }
.b-phoenix-v4 .pic { animation: phx4Counter 6s linear infinite; }
.b-phoenix-v4 .feather-ring { position: absolute; inset: 0; pointer-events: none; }
.b-phoenix-v4 .feather {
  position: absolute;
  top: 50%; left: 50%;
  width: 6px; height: 14px;
  margin: -7px 0 0 -3px;
  background:
    linear-gradient(180deg, rgba(255,255,255,.7) 0%, transparent 22%),
    linear-gradient(to top, #b71c1c 0%, #ff3d00 35%, #ff9100 65%, #ffeb3b 95%, transparent 100%);
  border-radius: 50% 50% 50% 50% / 70% 70% 30% 30%;
  transform-origin: 50% 50%;
  filter: drop-shadow(0 0 3px rgba(255,87,34,.85));
  animation: phx4Feather 1.4s ease-in-out infinite;
}
.b-phoenix-v4 .ft1  { transform: rotate(0deg)   translate(0,-52px); animation-delay: 0s; }
.b-phoenix-v4 .ft2  { transform: rotate(30deg)  translate(0,-52px); animation-delay: .11s; }
.b-phoenix-v4 .ft3  { transform: rotate(60deg)  translate(0,-52px); animation-delay: .22s; }
.b-phoenix-v4 .ft4  { transform: rotate(90deg)  translate(0,-52px); animation-delay: .33s; }
.b-phoenix-v4 .ft5  { transform: rotate(120deg) translate(0,-52px); animation-delay: .44s; }
.b-phoenix-v4 .ft6  { transform: rotate(150deg) translate(0,-52px); animation-delay: .55s; }
.b-phoenix-v4 .ft7  { transform: rotate(180deg) translate(0,-52px); animation-delay: .66s; }
.b-phoenix-v4 .ft8  { transform: rotate(210deg) translate(0,-52px); animation-delay: .77s; }
.b-phoenix-v4 .ft9  { transform: rotate(240deg) translate(0,-52px); animation-delay: .88s; }
.b-phoenix-v4 .ft10 { transform: rotate(270deg) translate(0,-52px); animation-delay: .99s; }
.b-phoenix-v4 .ft11 { transform: rotate(300deg) translate(0,-52px); animation-delay: 1.1s; }
.b-phoenix-v4 .ft12 { transform: rotate(330deg) translate(0,-52px); animation-delay: 1.21s; }
@keyframes phx4Spin { to { transform: rotate(360deg); } }
@keyframes phx4Counter { to { transform: rotate(-360deg); } }
@keyframes phx4Aura {
  0%, 100% { opacity: .55; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.06); }
}
@keyframes phx4Feather {
  0%, 100% { filter: drop-shadow(0 0 3px rgba(255,87,34,.85)) brightness(1); }
  50% { filter: drop-shadow(0 0 5px rgba(255,193,7,1)) brightness(1.3); }
}',
  `updated_at` = unixepoch() * 1000
WHERE `key` = 'phoenix-v4' AND `is_builtin` = 1;
