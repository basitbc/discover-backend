-- AlterTable
ALTER TABLE "SiteSettings" ADD COLUMN     "blogSectionBgId" INTEGER,
ADD COLUMN     "blogsBannerId" INTEGER,
ADD COLUMN     "destinationsBannerId" INTEGER,
ADD COLUMN     "packagesBannerId" INTEGER,
ADD COLUMN     "packagesOverviewId" INTEGER;

-- AddForeignKey
ALTER TABLE "SiteSettings" ADD CONSTRAINT "SiteSettings_packagesBannerId_fkey" FOREIGN KEY ("packagesBannerId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteSettings" ADD CONSTRAINT "SiteSettings_destinationsBannerId_fkey" FOREIGN KEY ("destinationsBannerId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteSettings" ADD CONSTRAINT "SiteSettings_blogsBannerId_fkey" FOREIGN KEY ("blogsBannerId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteSettings" ADD CONSTRAINT "SiteSettings_packagesOverviewId_fkey" FOREIGN KEY ("packagesOverviewId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteSettings" ADD CONSTRAINT "SiteSettings_blogSectionBgId_fkey" FOREIGN KEY ("blogSectionBgId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

