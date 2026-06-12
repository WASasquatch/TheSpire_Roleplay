-- Forums: vertical focus point for the header banner (0 = top of the
-- image, 100 = bottom, 50 = center). Banners render with cover-cropping,
-- so the keeper picks WHICH band of the image survives the crop.
ALTER TABLE `forums` ADD COLUMN `banner_focus_y` INTEGER NOT NULL DEFAULT 50;
