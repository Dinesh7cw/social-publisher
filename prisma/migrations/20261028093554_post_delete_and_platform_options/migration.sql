-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'POST_DELETED';
ALTER TYPE "AuditAction" ADD VALUE 'POST_UNPUBLISHED';

-- AlterEnum
ALTER TYPE "PostStatus" ADD VALUE 'DELETED';

-- AlterEnum
ALTER TYPE "TargetStatus" ADD VALUE 'DELETED';

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "deletedAt" TIMESTAMPTZ(3),
ADD COLUMN     "deletedById" TEXT;

-- AlterTable
ALTER TABLE "PostTarget" ADD COLUMN     "deletedAt" TIMESTAMPTZ(3),
ADD COLUMN     "platformOptions" JSONB;

-- AlterTable
ALTER TABLE "SocialAccountSecret" ADD COLUMN     "userTokenCipher" TEXT;

-- CreateIndex
CREATE INDEX "Post_deletedAt_idx" ON "Post"("deletedAt");
