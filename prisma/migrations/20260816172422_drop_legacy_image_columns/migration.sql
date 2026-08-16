-- AlterTable
ALTER TABLE "Blog" DROP COLUMN "bgImageLegacy",
DROP COLUMN "cardImageLegacy";

-- AlterTable
ALTER TABLE "Destination" DROP COLUMN "bgImageLegacy",
DROP COLUMN "cardImageLegacy",
DROP COLUMN "thumbnailLegacy";

-- AlterTable
ALTER TABLE "HeroSlide" DROP COLUMN "imageUrlLegacy";

-- AlterTable
ALTER TABLE "Package" DROP COLUMN "bgImageLegacy",
DROP COLUMN "cardImageLegacy";

-- AlterTable
ALTER TABLE "SiteSettings" DROP COLUMN "aboutImageBackLegacy",
DROP COLUMN "aboutImageFrontLegacy",
DROP COLUMN "contactBgImageLegacy";

-- AlterTable
ALTER TABLE "Testimonial" DROP COLUMN "imageUrlLegacy";

