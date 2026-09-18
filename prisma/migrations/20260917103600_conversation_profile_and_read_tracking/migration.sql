-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "lastReadAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ConversationSettings" ADD COLUMN     "notes" TEXT,
ADD COLUMN     "preferredName" TEXT,
ADD COLUMN     "relationshipLabel" TEXT;
