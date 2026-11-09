-- AlterTable
ALTER TABLE "FounderLead" ADD COLUMN "invitedAt" TIMESTAMP(3),
ADD COLUMN "invitationCount" INTEGER NOT NULL DEFAULT 0;
