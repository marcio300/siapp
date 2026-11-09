-- CreateEnum
CREATE TYPE "ScanSource" AS ENUM ('SIAPP', 'EVENTOS');

-- CreateEnum
CREATE TYPE "OutboundStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN "externalTicketId" TEXT,
ADD COLUMN "externalOrderId" TEXT;

-- AlterTable
ALTER TABLE "Scan" ADD COLUMN "source" "ScanSource" NOT NULL DEFAULT 'SIAPP',
ADD COLUMN "externalId" TEXT;

-- CreateTable
CREATE TABLE "OutboundEvent" (
    "id" TEXT NOT NULL,
    "producerId" TEXT NOT NULL,
    "eventId" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT,
    "status" "OutboundStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Scan_externalId_key" ON "Scan"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundEvent_dedupeKey_key" ON "OutboundEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "OutboundEvent_status_nextAttemptAt_idx" ON "OutboundEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OutboundEvent_producerId_createdAt_idx" ON "OutboundEvent"("producerId", "createdAt");

-- CreateIndex
CREATE INDEX "OutboundEvent_eventId_createdAt_idx" ON "OutboundEvent"("eventId", "createdAt");

-- AddForeignKey
ALTER TABLE "OutboundEvent" ADD CONSTRAINT "OutboundEvent_producerId_fkey" FOREIGN KEY ("producerId") REFERENCES "Producer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
