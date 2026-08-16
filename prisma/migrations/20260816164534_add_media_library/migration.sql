-- Media library: content records now reference a reusable Image row.
-- The previous URL columns are RENAMED (not dropped) so the backfill
-- script can read them; a later migration removes them.

ALTER TABLE "Blog" RENAME COLUMN "bgImage" TO "bgImageLegacy";
ALTER TABLE "Blog" RENAME COLUMN "cardImage" TO "cardImageLegacy";
ALTER TABLE "Destination" RENAME COLUMN "bgImage" TO "bgImageLegacy";
ALTER TABLE "Destination" RENAME COLUMN "cardImage" TO "cardImageLegacy";
ALTER TABLE "Destination" RENAME COLUMN "thumbnail" TO "thumbnailLegacy";
ALTER TABLE "HeroSlide" RENAME COLUMN "imageUrl" TO "imageUrlLegacy";
ALTER TABLE "Package" RENAME COLUMN "bgImage" TO "bgImageLegacy";
ALTER TABLE "Package" RENAME COLUMN "cardImage" TO "cardImageLegacy";
ALTER TABLE "SiteSettings" RENAME COLUMN "aboutImageBack" TO "aboutImageBackLegacy";
ALTER TABLE "SiteSettings" RENAME COLUMN "aboutImageFront" TO "aboutImageFrontLegacy";
ALTER TABLE "SiteSettings" RENAME COLUMN "contactBgImage" TO "contactBgImageLegacy";
ALTER TABLE "Testimonial" RENAME COLUMN "imageUrl" TO "imageUrlLegacy";

-- AlterTable
ALTER TABLE "Blog"
ADD COLUMN     "bgImageId" INTEGER,
ADD COLUMN     "cardImageId" INTEGER;

-- AlterTable
ALTER TABLE "Destination"
ADD COLUMN     "bgImageId" INTEGER,
ADD COLUMN     "cardImageId" INTEGER,
ADD COLUMN     "thumbnailId" INTEGER;

-- AlterTable
ALTER TABLE "HeroSlide"
ADD COLUMN     "imageId" INTEGER;

-- AlterTable
ALTER TABLE "Package"
ADD COLUMN     "bgImageId" INTEGER,
ADD COLUMN     "cardImageId" INTEGER;

-- AlterTable
ALTER TABLE "SiteSettings"
ADD COLUMN     "aboutImageBackId" INTEGER,
ADD COLUMN     "aboutImageFrontId" INTEGER,
ADD COLUMN     "contactBgImageId" INTEGER;

-- AlterTable
ALTER TABLE "Testimonial"
ADD COLUMN     "imageId" INTEGER;

-- CreateTable
CREATE TABLE "Image" (
    "id" SERIAL NOT NULL,
    "url" TEXT NOT NULL,
    "publicId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'cloudinary',
    "filename" TEXT NOT NULL,
    "alt" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "bytes" INTEGER,
    "format" TEXT,
    "folder" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Image_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Image_publicId_key" ON "Image"("publicId");

-- CreateIndex
CREATE INDEX "Image_createdAt_idx" ON "Image"("createdAt");

-- CreateIndex
CREATE INDEX "Image_folder_idx" ON "Image"("folder");

-- AddForeignKey
ALTER TABLE "Package" ADD CONSTRAINT "Package_cardImageId_fkey" FOREIGN KEY ("cardImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Package" ADD CONSTRAINT "Package_bgImageId_fkey" FOREIGN KEY ("bgImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Destination" ADD CONSTRAINT "Destination_cardImageId_fkey" FOREIGN KEY ("cardImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Destination" ADD CONSTRAINT "Destination_bgImageId_fkey" FOREIGN KEY ("bgImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Destination" ADD CONSTRAINT "Destination_thumbnailId_fkey" FOREIGN KEY ("thumbnailId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Blog" ADD CONSTRAINT "Blog_cardImageId_fkey" FOREIGN KEY ("cardImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Blog" ADD CONSTRAINT "Blog_bgImageId_fkey" FOREIGN KEY ("bgImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Testimonial" ADD CONSTRAINT "Testimonial_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HeroSlide" ADD CONSTRAINT "HeroSlide_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteSettings" ADD CONSTRAINT "SiteSettings_aboutImageBackId_fkey" FOREIGN KEY ("aboutImageBackId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteSettings" ADD CONSTRAINT "SiteSettings_aboutImageFrontId_fkey" FOREIGN KEY ("aboutImageFrontId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteSettings" ADD CONSTRAINT "SiteSettings_contactBgImageId_fkey" FOREIGN KEY ("contactBgImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

