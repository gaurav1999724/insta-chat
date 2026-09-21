-- AlterTable
ALTER TABLE "InstagramAccount" ADD COLUMN "webhookUserId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "InstagramAccount_webhookUserId_key" ON "InstagramAccount"("webhookUserId");
