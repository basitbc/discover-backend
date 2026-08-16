-- AlterTable
ALTER TABLE "SiteSettings" ADD COLUMN     "footerLogoId" INTEGER,
ADD COLUMN     "headerLogoId" INTEGER;

-- AddForeignKey
ALTER TABLE "SiteSettings" ADD CONSTRAINT "SiteSettings_headerLogoId_fkey" FOREIGN KEY ("headerLogoId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteSettings" ADD CONSTRAINT "SiteSettings_footerLogoId_fkey" FOREIGN KEY ("footerLogoId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

