-- CreateEnum
CREATE TYPE "EventSource" AS ENUM ('MANUAL', 'EVENTOS');

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('SIAPP_COLLECTS', 'PRODUCER_COLLECTS');

-- AlterTable
ALTER TABLE "Producer" ADD COLUMN "eventosOrgId" TEXT,
ADD COLUMN "eventosOrgName" TEXT,
ADD COLUMN "eventosAppUrl" TEXT,
ADD COLUMN "eventosWebhookUrl" TEXT,
ADD COLUMN "eventosWebhookSecretEnc" TEXT,
ADD COLUMN "eventosPreviousSecretEnc" TEXT,
ADD COLUMN "eventosPreviousSecretUntil" TIMESTAMP(3),
ADD COLUMN "eventosConnectedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Event" ADD COLUMN "source" "EventSource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN "externalId" TEXT,
ADD COLUMN "snapshotVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "pausedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Offer" ADD COLUMN "externalRef" TEXT,
ADD COLUMN "paymentMode" "PaymentMode" NOT NULL DEFAULT 'SIAPP_COLLECTS',
ADD COLUMN "keyCostOverride" INTEGER;

-- CreateTable
CREATE TABLE "ProducerApiKey" (
    "id" TEXT NOT NULL,
    "producerId" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "ProducerApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerIdempotency" (
    "id" TEXT NOT NULL,
    "producerId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerIdempotency_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Producer_eventosOrgId_key" ON "Producer"("eventosOrgId");

-- CreateIndex
CREATE UNIQUE INDEX "Event_producerId_externalId_key" ON "Event"("producerId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Offer_eventId_externalRef_key" ON "Offer"("eventId", "externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "ProducerApiKey_keyHash_key" ON "ProducerApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ProducerApiKey_producerId_revokedAt_idx" ON "ProducerApiKey"("producerId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerIdempotency_producerId_key_key" ON "PartnerIdempotency"("producerId", "key");

-- CreateIndex
CREATE INDEX "PartnerIdempotency_createdAt_idx" ON "PartnerIdempotency"("createdAt");

-- AddForeignKey
ALTER TABLE "ProducerApiKey" ADD CONSTRAINT "ProducerApiKey_producerId_fkey" FOREIGN KEY ("producerId") REFERENCES "Producer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProducerApiKey" ADD CONSTRAINT "ProducerApiKey_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerIdempotency" ADD CONSTRAINT "PartnerIdempotency_producerId_fkey" FOREIGN KEY ("producerId") REFERENCES "Producer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
