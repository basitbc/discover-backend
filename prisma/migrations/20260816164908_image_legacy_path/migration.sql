-- AlterTable
ALTER TABLE "HeroSlide" ALTER COLUMN "imageUrlLegacy" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Image" ADD COLUMN     "legacyPath" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Image_legacyPath_key" ON "Image"("legacyPath");

