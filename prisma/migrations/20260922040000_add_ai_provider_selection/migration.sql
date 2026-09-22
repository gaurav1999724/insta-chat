-- CreateEnum
CREATE TYPE "AIProvider" AS ENUM ('AUTO', 'GEMINI', 'OPENAI');

-- AlterEnum
ALTER TYPE "ErrorCategory" ADD VALUE 'OPENAI_ERROR';

-- AlterTable
ALTER TABLE "AIConfiguration" ADD COLUMN "aiProvider" "AIProvider" NOT NULL DEFAULT 'AUTO';
ALTER TABLE "AIResponse" ADD COLUMN "provider" "AIProvider" NOT NULL DEFAULT 'GEMINI';
ALTER TABLE "AIUsage" ADD COLUMN "provider" "AIProvider" NOT NULL DEFAULT 'GEMINI';