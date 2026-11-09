-- CreateEnum
CREATE TYPE "FounderLeadStatus" AS ENUM ('NEW', 'CONTACTED', 'CONVERTED', 'UNSUBSCRIBED');

-- CreateTable
CREATE TABLE "FounderLead" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "cityId" TEXT,
    "status" "FounderLeadStatus" NOT NULL DEFAULT 'NEW',
    "consentAt" TIMESTAMP(3) NOT NULL,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "utmContent" TEXT,
    "utmTerm" TEXT,
    "referrer" TEXT,
    "landingPath" TEXT,
    "unsubscribeToken" TEXT NOT NULL,
    "welcomeEmailSentAt" TIMESTAMP(3),
    "contactedAt" TIMESTAMP(3),
    "contactedById" TEXT,
    "convertedAt" TIMESTAMP(3),
    "memberId" TEXT,
    "unsubscribedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FounderLead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FounderLead_number_key" ON "FounderLead"("number");
CREATE UNIQUE INDEX "FounderLead_email_key" ON "FounderLead"("email");
CREATE UNIQUE INDEX "FounderLead_unsubscribeToken_key" ON "FounderLead"("unsubscribeToken");
CREATE UNIQUE INDEX "FounderLead_memberId_key" ON "FounderLead"("memberId");
CREATE INDEX "FounderLead_status_createdAt_idx" ON "FounderLead"("status", "createdAt");
CREATE INDEX "FounderLead_utmSource_idx" ON "FounderLead"("utmSource");

-- AddForeignKey
ALTER TABLE "FounderLead" ADD CONSTRAINT "FounderLead_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FounderLead" ADD CONSTRAINT "FounderLead_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FounderLead" ADD CONSTRAINT "FounderLead_contactedById_fkey" FOREIGN KEY ("contactedById") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
