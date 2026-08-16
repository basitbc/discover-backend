-- DropIndex
DROP INDEX "Image_legacyPath_key";

-- AlterTable
ALTER TABLE "Image" DROP COLUMN "legacyPath";

