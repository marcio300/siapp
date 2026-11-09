-- AlterTable: producer-collects payments (EventOS checkout) — contract §4.2 / §3.8
ALTER TABLE "Redemption" ADD COLUMN "qrPayload" TEXT,
ADD COLUMN "externalOrderId" TEXT,
ADD COLUMN "externalPayUrl" TEXT,
ADD COLUMN "externalRefundedAt" TIMESTAMP(3),
ADD COLUMN "externalRefundError" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Redemption_qrPayload_key" ON "Redemption"("qrPayload");
