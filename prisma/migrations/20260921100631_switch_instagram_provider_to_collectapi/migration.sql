-- Drop OAuth-specific InstagramAccount columns that no provider used by
-- this project since 2026-09-21 needs: CollectAPI (2026-09-21, reverted)
-- and SocialAPI.AI (2026-09-21, current) both hold the actual platform
-- session/token on their own side — this app only ever stores an opaque
-- external account reference (`instagramUserId`), never a bearer token.

-- DropIndex
DROP INDEX IF EXISTS "InstagramAccount_webhookUserId_key";

-- AlterTable
ALTER TABLE "InstagramAccount" DROP COLUMN IF EXISTS "webhookUserId";
ALTER TABLE "InstagramAccount" DROP COLUMN IF EXISTS "accessTokenEncrypted";
ALTER TABLE "InstagramAccount" DROP COLUMN IF EXISTS "tokenExpiresAt";
