-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'CREDENTIALS_SAVED';
ALTER TYPE "AuditAction" ADD VALUE 'CREDENTIALS_REMOVED';

-- CreateTable
CREATE TABLE "PlatformCredential" (
    "platform" "Platform" NOT NULL,
    "appId" TEXT NOT NULL,
    "appSecretCipher" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "PlatformCredential_pkey" PRIMARY KEY ("platform")
);

-- AddForeignKey
ALTER TABLE "PlatformCredential" ADD CONSTRAINT "PlatformCredential_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
