-- AlterTable
ALTER TABLE "MessageDelivery" ADD COLUMN "nextRetryAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "MessageDelivery_status_nextRetryAt_idx" ON "MessageDelivery"("status", "nextRetryAt");
