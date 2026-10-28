-- AlterTable
ALTER TABLE "Member" ADD COLUMN "onboardedAt" TIMESTAMP(3),
ADD COLUMN "partnerClaimToken" TEXT,
ADD COLUMN "partnerClaimTokenAt" TIMESTAMP(3),
ADD COLUMN "banReason" TEXT;

-- CreateTable
CREATE TABLE "PaymentMethodFingerprint" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "brand" TEXT,
    "last4" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentMethodFingerprint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentMethodFingerprint_fingerprint_idx" ON "PaymentMethodFingerprint"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentMethodFingerprint_memberId_fingerprint_key" ON "PaymentMethodFingerprint"("memberId", "fingerprint");

-- AddForeignKey
ALTER TABLE "PaymentMethodFingerprint" ADD CONSTRAINT "PaymentMethodFingerprint_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
